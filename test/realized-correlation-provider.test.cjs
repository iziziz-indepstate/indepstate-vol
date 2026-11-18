const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRealizedCorrelationService, parseHoldings, completedSessionDate } = require('../src/main/realized-correlation-provider.cjs');

function holdings() {
  return 'iShares Core S&P 500 ETF\nFund Holdings as of,"Nov 16, 2026"\n\nTicker,Name,Type,Asset Class,Market Weight\n'
    + Array.from({ length: 52 }, (_, i) => `S${String(i).padStart(2, '0')},"Company ${i}, Inc",EQUITY,Equity,${53 - i}`).join('\n')
    + '\nUSD,Cash,CASH,Cash,999\n';
}

function setup(t) {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'is-vol-correlation-'));
  t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }));
  const state = { count: 0, active: 0, maxActive: 0, failing: false, corFail: false, missingSymbol: null, calendarStarts: [], calendarShortOnce: false, time: new Date('2026-11-18T22:00:00Z') };
  const dates = ['2026-08-15', '2026-11-16', '2026-11-17', '2026-11-18'];
  const fetchImpl = async (url) => {
    state.count += 1; state.active += 1; state.maxActive = Math.max(state.maxActive, state.active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    state.active -= 1;
    if (state.failing) throw new Error('offline');
    if (url.includes('ishares')) return { ok: true, text: async () => holdings() };
    if (url.includes('cboe')) {
      if (state.corFail) throw new Error('COR offline');
      return { ok: true, text: async () => 'DATE,CLOSE\n11/16/2026,20\n11/17/2026,21\n11/18/2026,22' };
    }
    const symbol = decodeURIComponent(new URL(url).pathname.split('/').at(-1));
    if (symbol === state.missingSymbol) throw new Error('missing ticker');
    if (symbol === '^GSPC') {
      const query = new URL(url).searchParams;
      const start = Number(query.get('period1')) * 1000;
      const end = Number(query.get('period2')) * 1000;
      state.calendarStarts.push(start);
      const timestamps = [];
      for (let time = start; time < end; time += 86400000) {
        if (state.calendarShortOnce && state.calendarStarts.length === 1 && time < Date.parse('2026-09-20')) continue;
        if (![0, 6].includes(new Date(time).getUTCDay())) timestamps.push(time / 1000);
      }
      return { ok: true, json: async () => ({ chart: { result: [{ timestamp: timestamps,
        indicators: { quote: [{ close: timestamps.map(() => 200) }] } }] } }) };
    }
    return { ok: true, json: async () => ({ chart: { result: [{ timestamp: dates.map((date) => Date.parse(date) / 1000),
      indicators: { quote: [{ close: [200, 210, 220, 230] }], adjclose: [{ adjclose: [100, 105, 110, 115] }] } }] } }) };
  };
  return { state, service: createRealizedCorrelationService({ cacheDir, fetchImpl, now: () => state.time }) };
}

test('parses dated holdings, excludes cash, sorts Top 50 and normalizes weights', () => {
  const result = parseHoldings(holdings());
  assert.equal(result.asOf, '2026-11-16');
  assert.equal(result.basket.length, 50);
  assert.equal(result.basket[0].symbol, 'S00');
  assert.equal(result.basket.at(-1).symbol, 'S49');
  assert.ok(Math.abs(result.basket.reduce((sum, row) => sum + row.weight, 0) - 1) < 1e-12);
  assert.match(result.basket[0].name, /Company 0, Inc/);
  assert.throws(() => parseHoldings('<html>error</html>'), /header/);
  assert.throws(() => parseHoldings(holdings().split('\n').slice(0, 10).join('\n')), /expected 50/);
});

test('New York close cutoff handles DST and waits until 16:15 even on early-close days', () => {
  assert.equal(completedSessionDate(new Date('2026-11-18T21:14:00Z')), '2026-11-17');
  assert.equal(completedSessionDate(new Date('2026-11-18T21:15:00Z')), '2026-11-18');
  assert.equal(completedSessionDate(new Date('2026-07-02T20:14:00Z')), '2026-07-01');
});

test('uses adjusted prices, limits concurrency, shares requests and reuses covering caches', async (t) => {
  const { service, state } = setup(t);
  const request = { startDate: '2026-10-01', endDate: '2026-11-18' };
  const [first, duplicate] = await Promise.all([service.getInputs(request), service.getInputs(request)]);
  assert.deepEqual(first, duplicate);
  assert.equal(state.count, 53); // holdings + calendar + 50 stocks + COR1M
  assert.ok(state.maxActive <= 4);
  assert.equal(first.prices.S00.bars[0].close, 100);
  assert.equal(first.calendar.bars[0].close, 200);
  const cached = await service.getInputs({ startDate: '2026-10-10', endDate: '2026-11-17' });
  assert.equal(state.count, 53);
  assert.equal(cached.prices.S00.cached, true);
  assert.equal(cached.prices.S00.bars.at(-1).date, '2026-11-17');
  await service.getInputs({ ...request, forceRefresh: true });
  assert.equal(state.count, 106);
});

test('expired covering cache is explicit fallback; cache disabled never reads it', async (t) => {
  const { service, state } = setup(t);
  const request = { startDate: '2026-10-01', endDate: '2026-11-17' };
  await service.getInputs(request);
  state.time = new Date('2026-11-20T22:00:00Z'); state.failing = true;
  const result = await service.getInputs(request);
  assert.equal(result.prices.S00.cached, true);
  assert.ok(result.warnings.some((warning) => /using cache from/.test(warning)));
  await assert.rejects(service.getInputs({ ...request, cache: false }), /offline/);
});

test('COR1M failure preserves RC inputs; a missing stock fails without changing the basket', async (t) => {
  const { service, state } = setup(t);
  state.corFail = true;
  const result = await service.getInputs({ startDate: '2026-10-01', cache: false });
  assert.equal(result.cor1m, null);
  assert.equal(Object.keys(result.prices).length, 50);
  assert.match(result.warnings[0], /COR1M unavailable/);
  state.missingSymbol = 'S07';
  await assert.rejects(service.getInputs({ startDate: '2026-10-01', cache: false }), /S07:.*missing ticker/);
  await assert.rejects(service.getInputs({ startDate: '2026-02-30' }), /Invalid/);
});

test('extends short calendar coverage before loading stocks and reuses longer warmup caches', async (t) => {
  const { service, state } = setup(t);
  state.calendarShortOnce = true;
  const request = { startDate: '2026-10-01', endDate: '2026-11-17', ewmaHalfLife: 10 };
  const result = await service.getInputs(request);
  assert.equal(state.calendarStarts.length, 2);
  assert.ok(state.calendarStarts[1] < state.calendarStarts[0]);
  assert.ok(result.calendar.bars.filter((bar) => bar.date < request.startDate).length >= 100);
  const count = state.count;
  await service.getInputs({ ...request, ewmaHalfLife: 5 });
  assert.equal(state.count, count);
  await service.getInputs({ ...request, ewmaHalfLife: 63 });
  assert.ok(state.count > count);
});

test('rejects invalid half-lives before requests and defaults omitted half-life to ten', async (t) => {
  const { service, state } = setup(t);
  for (const ewmaHalfLife of [0, 64, 2.5, '', null, 'oops']) {
    await assert.rejects(service.getInputs({ ewmaHalfLife }), /half-life/);
  }
  assert.equal(state.count, 0);
  assert.equal((await service.getInputs({ startDate: '2026-10-01' })).ewmaHalfLife, 10);
});
