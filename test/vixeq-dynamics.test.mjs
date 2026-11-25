import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createMarketDataService } from '../src/main/market-data-providers.cjs';
import { createVixeqDynamicsService } from '../src/main/vixeq-dynamics-service.cjs';
import { getWidgetDefinition } from '../src/renderer/widgets/index.js';
import { calculateVixeqDynamics, describeVixeqDynamics, explainVixeqDynamics } from '../src/shared/vixeq-dynamics-calculations.mjs';

function sessionsFrom(start, days) {
  return Array.from({ length: days }, (_, i) => new Date(Date.parse(start) + i * 86_400_000))
    .filter((day) => day.getUTCDay() > 0 && day.getUTCDay() < 6)
    .map((day) => day.toISOString().slice(0, 10));
}

function closes(sessions, valueAt) {
  return sessions.map((date, i) => ({ date, close: valueAt(i) }));
}

test('decomposes the same spread change into its constituent or index driver', () => {
  const sessions = sessionsFrom('2026-01-05', 8);
  for (const [vixeq, vix, vixeqChange, vixChange, summary] of [
    [40, 25, 0, 10, 'Spread narrowing with rising VIX'],
    [30, 15, -10, 0, 'Spread narrowing with falling VIXEQ'],
    [45, 10, 5, -5, 'Spread widening with rising VIXEQ and falling VIX'],
    [45, 20, 5, 5, 'Spread unchanged'],
    [45, 25, 5, 10, 'Spread narrowing with rising VIX']
  ]) {
    const row = calculateVixeqDynamics(sessions, {
      vixeq: closes(sessions, (i) => i === 5 ? vixeq : 40),
      vix: closes(sessions, (i) => i === 5 ? vix : 15),
      cor1m: closes(sessions, (i) => i === 5 ? 25 : 20)
    }).at(-1);
    assert.equal(row.change5.vixeq, vixeqChange);
    assert.equal(row.change5.vix, vixChange);
    assert.equal(row.change5.spread, (vixeq - vix) - 25);
    assert.equal(row.change5.spread, row.change5.vixeq - row.change5.vix);
    assert.equal(describeVixeqDynamics(row), `${summary} · COR1M rising`);
  }
});

test('requires an exact date match and a complete prior-only Z-score window', () => {
  const sessions = sessionsFrom('2024-10-01', 390);
  const histories = {
    vixeq: closes(sessions, (i) => i === 252 ? 45 : 30 + i % 2),
    vix: closes(sessions, () => 15),
    cor1m: closes(sessions, () => -1)
  };
  const rows = calculateVixeqDynamics(sessions, histories);
  assert.equal(rows[251].zScore.vixeq, null);
  assert.deepEqual(rows[252].zScore, { vixeq: 29, spread: 29 });
  assert.equal(rows[252].change20.vixeq, 15);
  assert.equal(rows.find(({ date }) => date === '2024-11-01').retrospective, true);
  assert.equal(rows.find(({ date }) => date === '2024-11-04').retrospective, false);
  assert.equal(rows[252].cor1m, -1);

  histories.vix.splice(247, 1);
  histories.cor1m.pop();
  const gaps = calculateVixeqDynamics(sessions, histories);
  assert.equal(gaps[247].spread, null);
  assert.equal(gaps[252].change5.spread, null);
  assert.equal(gaps[252].change5.vixeq, 14);
  assert.deepEqual(gaps[252].zScore, { vixeq: 29, spread: null });
  assert.match(describeVixeqDynamics(gaps.at(-1)), /COR1M change unavailable/);

  histories.vixeq = closes(sessions, () => 30.1);
  assert.equal(calculateVixeqDynamics(sessions, histories)[252].zScore.vixeq, null);
});

test('explains changes in expected stock and index volatility alongside implied co-movement', () => {
  assert.equal(explainVixeqDynamics({ change5: { vixeq: 2, vix: 1, spread: 1, cor1m: 3 } }),
    'Expected volatility rose for both individual S&P 500 stocks and the index, with a larger increase for individual stocks. Options price in stronger co-movement among stocks.');
  assert.equal(explainVixeqDynamics({ change5: { vixeq: -2, vix: -1, spread: -1, cor1m: -3 } }),
    'Expected volatility fell for both individual S&P 500 stocks and the index, with a larger decrease for individual stocks. Options price in weaker co-movement among stocks.');
  assert.equal(explainVixeqDynamics({ change5: { vixeq: 0, vix: 2, spread: -2, cor1m: 0 } }),
    'Expected volatility held steady for individual S&P 500 stocks while it rose for the index as a whole. The degree of co-movement implied by options held steady.');
  assert.equal(explainVixeqDynamics({ change5: { vixeq: 1, vix: null, spread: null, cor1m: null } }),
    'Expected volatility rose for individual S&P 500 stocks.');
  assert.equal(explainVixeqDynamics({ change5: { vixeq: null, vix: null, spread: null, cor1m: -1 } }),
    'Options price in weaker co-movement among stocks.');
  assert.equal(explainVixeqDynamics({ change5: { vixeq: null, vix: null, spread: null, cor1m: null } }), '');
});

test('loads VIXEQ from Cboe and a local override, with session cutoff, gaps and stable lookback', async (t) => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'is-vol-vixeq-'));
  t.after(() => rm(cacheDir, { recursive: true, force: true }));
  const holiday = '2026-11-26';
  const sessions = sessionsFrom('2025-07-01', 520).filter((date) => date !== holiday);
  const requests = [];
  let offline = false;
  const marketData = createMarketDataService({
    cacheDir,
    async fetchImpl(url) {
      requests.push(url);
      if (offline) throw new Error('Offline');
      const symbol = url.match(/(VIXEQ|VIX|COR1M)_History\.csv$/)?.[1];
      const header = symbol === 'VIXEQ' ? 'DATE,VIXEQ' : 'DATE,CLOSE';
      const data = sessions.filter((date) => symbol !== 'COR1M' || date !== '2026-11-27')
        .map((date, i) => `${date},${symbol === 'VIXEQ' ? 30 + i % 9 : 15 + i % 3}`);
      return { ok: true, text: async () => [header, ...data].join('\n') };
    }
  });
  let now = '2026-11-30T21:14:59Z';
  const service = createVixeqDynamicsService({
    marketData, getMarketHolidays: async () => [holiday], now: () => new Date(now)
  });
  const delayed = await service.getState({ startDate: '2026-11-20' });
  assert.equal(requests.length, 3);
  assert.equal(delayed.latest.date, '2026-11-27');
  assert.equal(delayed.latest.cor1m, null);
  assert.equal(delayed.sources.cor1m.latestDate, '2026-11-25');
  assert.equal(delayed.status, 'partial');
  assert.ok(!delayed.series.some(({ date }) => date === holiday));
  assert.ok(Number.isFinite(delayed.latest.zScore.spread));
  assert.match(delayed.warnings.join(' '), /COR1M close for 2026-11-27 is unavailable/);

  now = '2026-11-30T21:15:00Z';
  const extended = await service.getState({ startDate: '2026-08-01' });
  assert.equal(extended.latest.date, '2026-11-30');
  assert.deepEqual(extended.series.find(({ date }) => date === delayed.latest.date), delayed.latest);
  assert.equal(extended.sources.vixeq.provider, 'cboe');

  const localSource = join(cacheDir, 'vixeq.csv');
  await writeFile(localSource, 'date,close\n2026-11-30,42\n');
  const local = await service.getState({ startDate: '2026-11-30', vixeqLocalSource: localSource, forceRefresh: true });
  assert.equal(local.latest.vixeq, 42);
  assert.equal(local.latest.change5.spread, null);
  assert.equal(local.sources.vixeq.provider, 'local');
  assert.equal(local.status, 'ok');

  const missingLocal = await service.getState({ startDate: '2026-11-30', vixeqLocalSource: join(cacheDir, 'missing.csv') });
  assert.equal(missingLocal.status, 'partial');
  assert.equal(missingLocal.latest.spread, null);
  assert.ok(Number.isFinite(missingLocal.latest.vix));
  assert.match(missingLocal.warnings.join(' '), /Local market data source not found/);

  offline = true;
  const stale = await service.getState({ startDate: '2026-11-30', forceRefresh: true });
  assert.equal(stale.sources.vixeq.stale, true);
  assert.equal(stale.status, 'partial');
  const noSession = await service.getState({ startDate: holiday, endDate: holiday });
  assert.equal(noSession.status, 'error');
  assert.equal(noSession.latest, null);
});

test('registers an independent VIXEQ widget with its own daily inputs', () => {
  const definition = getWidgetDefinition('vixeq-dynamics');
  assert.equal(definition.defaultTitle, 'VIX. VIXEQ Dynamics');
  assert.equal(definition.providerKey, null);
  assert.equal(definition.mode, 'table');
});

test('saves the spread view without loading data and restores it on a new render', async (t) => {
  const definition = getWidgetDefinition('vixeq-dynamics');
  const widget = { type: definition.type };
  const view = { addEventListener(_event, listener) { this.change = listener; } };
  const button = { addEventListener(_event, listener) { this.click = listener; } };
  const spread = {};
  const content = { querySelector: (selector) => ({
    '[data-vixeq-view]': view,
    '[data-vixeq-chart="spread"]': spread
  })[selector] ?? {} };
  const container = { querySelector: (selector) => selector === '[data-vixeq-refresh]' ? button : content, querySelectorAll: () => [] };
  const latest = calculateVixeqDynamics(['2026-11-30'], { vixeq: [], vix: [], cor1m: [] })[0];
  const requests = [];
  const published = [];
  const previousWindow = global.window;
  t.after(() => { global.window = previousWindow; });
  global.window = {
    Chart: class {
      constructor(canvas, { data, options }) {
        Object.assign(this, { data, options, tooltip: { setActiveElements() {} } });
        canvas.chart = this;
      }
      update() {}
      destroy() {}
    },
    appBridge: { async getVixeqDynamics(request) {
      requests.push(request);
      return { status: 'partial', latest, series: [latest], sources: {}, warnings: [] };
    } }
  };
  let saved;
  const render = (instance) => definition.render({ container, widget: instance,
    widgetData: { publish: (data) => published.push(data) },
    onConfigChange(options) {
      assert.deepEqual(options, { refresh: false });
      saved = structuredClone(instance.config);
    }
  });

  await render(widget);
  assert.match(content.innerHTML, /value="level" selected/);
  view.change({ target: { value: 'contributions' } });
  assert.equal(requests.length, 1);
  assert.equal(saved.spreadView, 'contributions');
  assert.equal(published.at(-1).config.spreadView, 'contributions');
  assert.equal(spread.chart.data.datasets.length, 3);

  await button.click();
  assert.match(content.innerHTML, /value="contributions" selected/);
  await render({ type: definition.type, config: saved });
  assert.match(content.innerHTML, /value="contributions" selected/);
  assert.equal(spread.chart.data.datasets.length, 3);
  view.change({ target: { value: 'level' } });
  assert.equal(saved.spreadView, 'level');
  assert.equal(spread.chart.data.datasets.length, 1);
  assert.equal(requests.length, 3);
});
