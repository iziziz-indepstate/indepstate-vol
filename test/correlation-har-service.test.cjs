const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createCorrelationHarService, createHarScheduler, INTERVAL } = require('../src/main/correlation-har-service.cjs');

async function setup(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'har-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const state = { time: new Date('2026-11-18T22:00:00Z'), calls: [], failing: false, revision: false, computations: 0, active: 0, maxActive: 0 };
  const fetchImpl = async (url) => {
    state.calls.push(url);
    if (state.failing) throw new Error('offline');
    if (url.includes('ishares')) return { ok: true, text: async () => 'Fund Holdings as of,"Nov 18, 2026"\nTicker,Name,Asset Class,Weight (%)\n'
      + Array.from({ length: 50 }, (_, i) => `S${i},Stock ${i},Equity,2`).join('\n') };
    if (url.includes('cboe')) return { ok: true, text: async () => 'DATE,CLOSE\n11/18/2026,25\n11/19/2026,26\n' };
    const query = new URL(url).searchParams;
    const symbol = decodeURIComponent(new URL(url).pathname.split('/').at(-1));
    const timestamp = [];
    const max = Date.parse(state.priceEndBySymbol?.[symbol] || state.priceEndDate || state.time.toISOString().slice(0, 10));
    for (let time = Number(query.get('period1')) * 1000; time < Number(query.get('period2')) * 1000 && time <= max; time += 86400000) {
      if (![0, 6].includes(new Date(time).getUTCDay())) timestamp.push(time / 1000);
    }
    state.active += 1; state.maxActive = Math.max(state.maxActive, state.active);
    await new Promise((resolve) => setImmediate(resolve)); state.active -= 1;
    const close = timestamp.map((time) => 100 + (time / 86400) % 200);
    const adjusted = close.map((value) => value * (state.revision && symbol === 'S0' ? 0.5 : 1));
    return { ok: true, json: async () => ({ chart: { result: [{ timestamp, indicators: { quote: [{ close }], adjclose: [{ adjclose: adjusted }] } }] } }) };
  };
  const compute = async ({ inputs, records, makeForecast }) => {
    state.computations += 1;
    const date = inputs.calendarRows.at(-1).date;
    return { records, forecast: makeForecast ? { date, forecast: 30, cor1m: inputs.cor1mRows.find((row) => row.date === date)?.close ?? null,
      spread: 5, factors: { rc5: 10, rc10: 20, rc21: 25, rcEwma: 28 }, coefficients: { intercept: 1 },
      model: { version: 1, horizon: 21 }, training: { samples: 1260 }, fact: null, error: null, targetEndDate: null, warnings: [] } : null };
  };
  const options = { directory, fetchImpl, now: () => state.time, compute };
  return { state, directory, options, service: createCorrelationHarService(options) };
}

test('shares loads, persists a single immutable forecast and reopens it without historical backfill', async (t) => {
  const h = await setup(t);
  const [a, b] = await Promise.all([h.service.getState(), h.service.getState()]);
  assert.deepEqual(a, b);
  assert.equal(a.status, 'ok', a.error);
  assert.equal(a.records.length, 1);
  assert.equal(a.latest.date, '2026-11-18');
  assert.equal(h.state.computations, 1);
  assert.ok(h.state.maxActive <= 4);
  const count = h.state.calls.length;
  await h.service.getState();
  assert.equal(h.state.calls.length, count);
  const refreshed = await h.service.getState({ refresh: true });
  assert.deepEqual(refreshed.latest, a.latest);
  const reopened = await createCorrelationHarService(h.options).getState();
  assert.deepEqual(reopened.records, a.records);
  assert.equal(h.state.computations, 1);
  const archive = JSON.parse(await fs.readFile(path.join(h.directory, 'forecasts.json'), 'utf8'));
  assert.deepEqual(archive.records, a.records);
});

test('new sessions request only the tail and adjusted revisions reload affected ticker history', async (t) => {
  const h = await setup(t);
  const first = await h.service.getState();
  h.state.calls = [];
  h.state.time = new Date('2026-11-19T22:00:00Z'); h.state.revision = true;
  const next = await h.service.getState();
  assert.equal(next.records.length, 2);
  assert.deepEqual(next.records[0], first.latest);
  const stockCalls = h.state.calls.filter((url) => url.includes('/S'));
  const s0 = stockCalls.filter((url) => url.includes('/S0?'));
  const s1 = stockCalls.filter((url) => url.includes('/S1?'));
  assert.equal(s0.length, 2);
  assert.equal(s1.length, 1);
  assert.ok(Number(new URL(s0[1]).searchParams.get('period1')) < Number(new URL(s0[0]).searchParams.get('period1')));
  const span = new URL(s1[0]).searchParams;
  assert.ok((Number(span.get('period2')) - Number(span.get('period1'))) / 86400 < 40);
});

test('offline refresh preserves saved forecast and reports stale data without creating a new record', async (t) => {
  const h = await setup(t);
  const first = await h.service.getState();
  h.state.failing = true;
  h.state.time = new Date('2026-11-19T22:00:00Z');
  const failed = await h.service.getState({ refresh: true });
  assert.equal(failed.status, 'partial');
  assert.deepEqual(failed.records, first.records);
  assert.match(failed.error, /offline/);
});

test('corrupt forecast archive is never overwritten', async (t) => {
  const h = await setup(t);
  await fs.writeFile(path.join(h.directory, 'forecasts.json'), '{broken', 'utf8');
  const result = await h.service.getState();
  assert.equal(result.status, 'error');
  assert.equal(h.state.calls.length, 0);
  assert.equal(await fs.readFile(path.join(h.directory, 'forecasts.json'), 'utf8'), '{broken');
});

test('delayed SPX never causes a forecast to be backfilled for an older session', async (t) => {
  const h = await setup(t);
  h.state.priceEndDate = '2026-11-17';
  const result = await h.service.getState();
  assert.equal(result.status, 'error');
  assert.equal(result.records.length, 0);
  assert.match(result.error, /waiting for completed session 2026-11-18/);
  assert.equal(h.state.computations, 0);
});

test('holiday calendar permits the actual previous trading session', async (t) => {
  const h = await setup(t);
  h.state.priceEndDate = '2026-11-17';
  const service = createCorrelationHarService({ ...h.options, getMarketHolidays: async () => ['2026-11-18'] });
  const result = await service.getState();
  assert.equal(result.status, 'partial'); // fixture COR1M starts on the following day
  assert.equal(result.latest.date, '2026-11-17');
});

test('failed atomic commit never exposes an unpersisted forecast as saved', async (t) => {
  const h = await setup(t);
  const first = await h.service.getState();
  await fs.mkdir(path.join(h.directory, 'forecasts.json.tmp'));
  h.state.time = new Date('2026-11-19T22:00:00Z');
  const failed = await h.service.getState();
  assert.equal(failed.status, 'partial');
  assert.deepEqual(failed.records, first.records);
  assert.ok(failed.error);
  const saved = JSON.parse(await fs.readFile(path.join(h.directory, 'forecasts.json'), 'utf8'));
  assert.deepEqual(saved.records, first.records);
});

test('maturity updates the saved original basket even after a ticker leaves current holdings', async (t) => {
  const h = await setup(t);
  const first = await h.service.getState();
  h.state.time = new Date('2026-12-21T22:00:00Z');
  h.state.priceEndBySymbol = { S0: '2026-12-17' }; // No latest close, but the original target window is complete.
  const changedFetch = async (url, options) => {
    const response = await h.options.fetchImpl(url, options);
    if (!url.includes('ishares')) return response;
    const text = (await response.text()).replace('S0,Stock 0', 'NEW,New Stock');
    return { ok: true, text: async () => text };
  };
  const compute = async ({ inputs, records, makeForecast }) => {
    assert.ok(inputs.prices.S0, 'outgoing ticker must still be loaded');
    assert.ok(inputs.prices.NEW, 'new basket ticker must be loaded');
    assert.deepEqual(records[0].basket, first.latest.basket);
    return { records: records.map((row) => ({ ...row, fact: 22, error: row.forecast - 22, targetEndDate: '2026-12-17' })),
      forecast: null, error: makeForecast ? 'fixture suppresses new forecast' : null };
  };
  const matured = await createCorrelationHarService({ ...h.options, fetchImpl: changedFetch, compute }).getState();
  assert.equal(matured.records[0].forecast, first.latest.forecast);
  assert.equal(matured.records[0].issuedAt, first.latest.issuedAt);
  assert.equal(matured.records[0].fact, 22);
  assert.equal(matured.records[0].error, 8);
});

test('scheduler follows widgets across all tabs and stops after the last instance is removed', () => {
  let tabs = [], callback, stopped = 0, calls = 0;
  const scheduler = createHarScheduler({ service: { getState: async () => { calls += 1; } }, getTabs: () => tabs,
    setTimer: (fn, delay) => { assert.equal(delay, INTERVAL); callback = fn; return { unref() {} }; }, clearTimer: () => { stopped += 1; } });
  scheduler.sync(); assert.equal(calls, 0);
  tabs = [{ widgets: [] }, { widgets: [{ type: 'correlation-har' }] }];
  scheduler.sync(); assert.equal(calls, 1);
  scheduler.sync(); assert.equal(calls, 1);
  callback(); assert.equal(calls, 2);
  tabs = []; scheduler.sync(); assert.equal(stopped, 1);
  scheduler.stop(); assert.equal(stopped, 1);
});
