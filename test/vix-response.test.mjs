import assert from 'node:assert/strict';
import test from 'node:test';
import { createVixResponseService } from '../src/main/vix-response-service.cjs';
import { calculateResidualBands, calculateVixResponse } from '../src/shared/vix-response-calculations.mjs';
import { sourceForWidget } from '../src/shared/data-sources.mjs';
import { getWidgetDefinition } from '../src/renderer/widgets/index.js';

function sample(sessions, returnAt = (i) => i % 4 - 1.5) {
  const spxBars = [];
  const vixBars = [];
  let spx = 100;
  let vix = 40;
  for (const [i, date] of sessions.entries()) {
    const move = returnAt(i);
    spx *= 1 + move / 100;
    vix -= 2 * move - 0.1;
    spxBars.push({ date, close: spx });
    vixBars.push({ date, close: vix });
  }
  return { sessions, spxBars, vixBars };
}

const sessionDates = Array.from({ length: 100 }, (_, i) => new Date(Date.UTC(2026, 0, i + 1)))
  .filter((day) => day.getUTCDay() > 0 && day.getUTCDay() < 6)
  .map((day) => day.toISOString().slice(0, 10));

test('fits exactly 60 prior changes and keeps the scored close out of the fit', () => {
  const inputs = sample(sessionDates);
  const before = calculateVixResponse(inputs);
  assert.equal(before[60].expectedChange, null);
  assert.ok(Math.abs(before[61].coefficients.alpha - 0.1) < 1e-12);
  assert.ok(Math.abs(before[61].coefficients.beta + 2) < 1e-12);
  assert.ok(Math.abs(before[61].residual) < 1e-12);
  inputs.vixBars[61].close += 1.5;
  const after = calculateVixResponse(inputs);
  assert.deepEqual(after[61].coefficients, before[61].coefficients);
  assert.equal(after[61].expectedChange, before[61].expectedChange);
  assert.ok(Math.abs(after[61].residual - 1.5) < 1e-12);
  assert.notDeepEqual(after[62].coefficients, before[62].coefficients);
});

test('preserves missing sessions and rejects constant SPX returns', () => {
  const inputs = sample(sessionDates);
  inputs.spxBars.splice(63, 1);
  const series = calculateVixResponse(inputs);
  assert.equal(series[63].spxReturn, null);
  assert.equal(series[64].spxReturn, null);
  assert.equal(series[65].coefficients, null);
  assert.equal(series.length, sessionDates.length);
  assert.equal(calculateVixResponse(sample(sessionDates, () => 0.5)).at(-1).expectedChange, null);
});

test('centers three-sigma bands on the mean of finite displayed residuals', () => {
  const series = [{ residual: 1 }, { residual: null }, { residual: 3 }, { residual: NaN }];
  assert.deepEqual(calculateResidualBands(series), { count: 2, mean: 2, sigma: 1, lower: -1, upper: 5 });
  assert.equal(calculateResidualBands(series.slice(0, 2)), null);
});

test('loads a completed-session chart with explicit delay, stale cache and error states', async () => {
  const requests = [];
  const holiday = '2026-11-26';
  const sessions = [];
  for (const day = new Date('2026-01-01'); day <= new Date('2026-11-30'); day.setUTCDate(day.getUTCDate() + 1)) {
    const date = day.toISOString().slice(0, 10);
    if (![0, 6].includes(day.getUTCDay()) && date !== holiday) sessions.push(date);
  }
  const { spxBars, vixBars } = sample(sessions);
  let time = '2026-11-30T21:14:59Z';
  let delay = true;
  let stale = false;
  let unavailable = false;
  let spxFallback = false;
  const service = createVixResponseService({
    now: () => new Date(time),
    getMarketHolidays: async (_date, options) => {
      assert.equal(options.startYear, 2026);
      return [holiday];
    },
    marketData: { async getDailyHistory(request) {
      requests.push(request);
      const spx = request.symbol === 'SPX';
      if (!spx && unavailable) throw new Error('Offline');
      const provider = spx && spxFallback ? 'yahoo' : request.provider;
      const bars = (spx ? spxBars : vixBars).filter(({ date }) => date >= request.startDate && date <= request.endDate);
      const missingClose = (spx && provider === 'fred') || (!spx && delay);
      return { provider, bars: missingClose ? bars.slice(0, -1) : bars, cached: stale, cacheFresh: !stale,
        warning: stale ? 'Remote refresh failed; using stale cache.' : undefined };
    } }
  });
  const pending = service.getState();
  assert.equal(service.getState(), pending);
  const delayed = await pending;
  assert.equal(delayed.status, 'partial');
  assert.equal(delayed.latest.date, '2026-11-27');
  assert.equal(delayed.sources.vix.latestDate, '2026-11-25');
  assert.equal(delayed.latest.residual, null);
  assert.equal(delayed.startDate, '2026-08-29');
  assert.equal(delayed.endDate, '2026-11-29');
  assert.equal(delayed.series[0].date, '2026-08-31');
  assert.notEqual(delayed.series[0].residual, null);
  assert.ok(delayed.series.every(({ date }) => date !== holiday));
  assert.ok(delayed.series.some(({ residual }) => residual !== null));
  assert.equal(delayed.residualBands.count, delayed.series.filter(({ residual }) => residual !== null).length);
  assert.deepEqual(requests.map(({ symbol, provider }) => [symbol, provider]), [['SPX', 'yahoo'], ['VIX', 'cboe']]);
  assert.ok(requests.every((request) => request.dataMode === 'hybrid' && request.fallbackProviders === undefined));

  time = '2026-11-30T21:15:00Z';
  delay = false;
  const refresh = service.getState({ forceRefresh: true });
  assert.equal(service.getState(), refresh);
  assert.equal((await refresh).status, 'ok');
  assert.ok(requests.slice(-2).every((request) => request.forceRefresh && request.endDate === '2026-11-30'));

  const fred = service.getState({ spxProvider: 'fred', ivProvider: 'yahoo' });
  const yahoo = service.getState({ spxProvider: 'yahoo', ivProvider: 'yahoo' });
  assert.notEqual(fred, yahoo);
  const [fredResult, yahooResult] = await Promise.all([fred, yahoo]);
  assert.equal(fredResult.status, 'partial');
  assert.equal(fredResult.sources.spx.latestDate, '2026-11-27');
  assert.ok(fredResult.warnings.includes('SPX close for 2026-11-30 is unavailable.'));
  assert.equal(yahooResult.status, 'ok');
  assert.equal(yahooResult.sources.spx.provider, 'yahoo');
  assert.equal(yahooResult.sources.vix.provider, 'yahoo');

  const singleDate = service.getState({ startDate: '2026-10-02', endDate: '2026-10-02' });
  const monthEnd = service.getState({ endDate: '2026-11-30' });
  assert.notEqual(singleDate, monthEnd);
  const [single, month] = await Promise.all([singleDate, monthEnd]);
  assert.equal(single.status, 'ok');
  assert.equal(single.residualBands, null);
  assert.deepEqual(single.series, [yahooResult.series.find(({ date }) => date === '2026-10-02')]);
  assert.equal(month.startDate, '2026-08-30');
  assert.equal(month.latest.date, '2026-11-30');
  const futureEnd = await service.getState({ startDate: '2026-10-02', endDate: '2027-01-01' });
  assert.equal(futureEnd.endDate, '2026-11-30');
  assert.equal(futureEnd.series[0].date, '2026-10-02');
  const weekend = await service.getState({ startDate: '2026-11-28', endDate: '2026-11-29' });
  assert.deepEqual(weekend.series, []);
  assert.match(weekend.error, /No completed sessions/);
  await assert.rejects(service.getState({ startDate: '2026-11-30', endDate: '2026-11-01' }), /Start date/);
  await assert.rejects(service.getState({ startDate: '2026-02-30' }), /valid start and end dates/);

  spxFallback = true;
  const fallback = await service.getState({ spxProvider: 'fred', ivProvider: 'fred' });
  assert.equal(fallback.status, 'ok');
  assert.equal(fallback.sources.spx.requestedProvider, 'fred');
  assert.equal(fallback.sources.spx.provider, 'yahoo');
  assert.equal(fallback.sources.spx.fallback, true);
  assert.equal(fallback.sources.vix.provider, 'fred');
  stale = true;
  const cached = await service.getState({ forceRefresh: true });
  assert.equal(cached.status, 'partial');
  assert.equal(cached.sources.vix.stale, true);
  assert.notEqual(cached.latest.residual, null);
  unavailable = true;
  const failed = await service.getState({ forceRefresh: true });
  assert.equal(failed.status, 'error');
  assert.ok(failed.warnings.includes('VIX unavailable. Offline'));
});

test('registers a standalone widget and refreshes its charts and published data', async (t) => {
  const definition = getWidgetDefinition('vix-response');
  assert.equal(definition.defaultTitle, 'VIX. Response');
  const widget = { type: definition.type };
  assert.deepEqual(definition.defaultConfig, { spxProvider: 'yahoo', ivProvider: 'cboe', startDate: '', endDate: '' });
  assert.equal(definition.gridSpan, getWidgetDefinition('iv-rv-local').gridSpan);
  assert.equal(sourceForWidget({ dataSources: [{ providerKey: 'tradingview' }] }, widget, getWidgetDefinition), null);
  const button = { addEventListener(_event, listener) { this.click = listener; } };
  const content = { querySelector: () => ({}) };
  const controls = ['spxProvider', 'ivProvider', 'startDate', 'endDate'].map((key) => ({
    dataset: { vixConfig: key }, addEventListener(_event, listener) { this.change = listener; }
  }));
  const container = { querySelector: (selector) => selector === '[data-vix-refresh]' ? button : content, querySelectorAll: () => controls };
  const charts = [];
  const calls = [];
  const published = [];
  const pending = Promise.withResolvers();
  let configChanges = 0;
  const row = { date: '2026-11-27', spxReturn: -1, actualChange: 3.5, expectedChange: 2, residual: 1.5 };
  const previousWindow = global.window;
  t.after(() => { global.window = previousWindow; });
  global.window = {
    Chart: class {
      constructor(_canvas, config) { this.config = config; charts.push(this); }
      destroy() { this.destroyed = true; }
    },
    appBridge: { async getVixResponse(request) {
      calls.push(request);
      const { spxProvider, ivProvider, forceRefresh } = request;
      if (spxProvider === 'fred' && ivProvider === 'cboe') await pending.promise;
      const latest = forceRefresh ? { ...row, date: '2026-11-30', actualChange: null, residual: null } : row;
      const series = forceRefresh ? [row, latest] : [{ ...row, date: '2026-11-25', actualChange: 1.5, residual: -0.5 }, row];
      return { status: forceRefresh ? 'partial' : 'ok', startDate: request.startDate || '2026-08-27', endDate: request.endDate || latest.date,
        latest, series, residualBands: calculateResidualBands(series), model: { windowSessions: 60 },
        sources: { spx: { provider: 'yahoo', requestedProvider: spxProvider, latestDate: latest.date },
          vix: { provider: ivProvider, requestedProvider: ivProvider, latestDate: row.date } }, warnings: [] };
    } }
  };
  const render = () => definition.render({ container, widget, widgetData: { publish: (data) => published.push(data) },
    onConfigChange: () => { configChanges += 1; latestRender = render(); } });
  let latestRender;
  await render();
  assert.match(container.innerHTML, /<option value="yahoo" selected>Yahoo/);
  assert.match(container.innerHTML, /<option value="cboe" selected>Cboe/);
  assert.match(content.innerHTML, /\+1\.50 pts/);
  assert.match(content.innerHTML, /class="ivrv-charts"/);
  assert.equal(charts.length, 2);
  assert.equal(charts[0].config.data.datasets.length, 2);
  assert.deepEqual(charts[1].config.data.datasets.slice(2).map(({ label, data, borderColor }) => [label, data, borderColor]), [
    ['Mean + 3σ', [3.5, 3.5], '#a78bfa'], ['Mean − 3σ', [-2.5, -2.5], '#a78bfa'],
    ['Mean + 4σ', [4.5, 4.5], '#ef4444'], ['Mean − 4σ', [-3.5, -3.5], '#ef4444']
  ]);
  await button.click();
  const initialRequest = { spxProvider: 'yahoo', ivProvider: 'cboe', startDate: '', endDate: '', forceRefresh: false };
  assert.deepEqual(calls, [initialRequest, { ...initialRequest, forceRefresh: true }]);
  assert.equal(published.at(-1).status, 'partial');
  assert.match(content.innerHTML, /Residual<\/span><strong>—/);
  assert.deepEqual(charts.at(-1).config.data.datasets[0].data, [1.5, null]);
  assert.deepEqual(charts.at(-1).config.data.datasets[1].data, [0, 0]);
  assert.equal(charts.at(-1).config.data.datasets.length, 2);
  assert.ok(charts[0].destroyed && charts[1].destroyed);

  controls[0].value = 'fred';
  controls[0].change();
  const superseded = latestRender;
  controls[1].value = 'yahoo';
  controls[1].change();
  await latestRender;
  assert.equal(configChanges, 2);
  assert.deepEqual(widget.config, { spxProvider: 'fred', ivProvider: 'yahoo' });
  assert.deepEqual(published.at(-1).config, { ...widget.config, startDate: '', endDate: '' });
  assert.match(content.innerHTML, /SPX \/ Yahoo \(FRED selected\)/);
  assert.match(content.innerHTML, /VIX \/ Yahoo/);
  const publishedCount = published.length;
  pending.resolve();
  await superseded;
  assert.equal(published.length, publishedCount);
  controls[2].value = '2026-11-01';
  controls[2].change();
  controls[3].value = '2026-11-27';
  controls[3].change();
  await latestRender;
  assert.equal(widget.config.startDate, '2026-11-01');
  assert.equal(widget.config.endDate, '2026-11-27');
  assert.match(content.innerHTML, /2026-11-01 – 2026-11-27/);
  await button.click();
  assert.deepEqual(calls.at(-1), { ...widget.config, forceRefresh: true });
  definition.destroy(container);
  assert.ok(charts.every((chart) => chart.destroyed));
});
