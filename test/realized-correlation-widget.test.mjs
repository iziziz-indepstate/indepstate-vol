import test from 'node:test';
import assert from 'node:assert/strict';
import { realizedCorrelationWidget as definition } from '../src/renderer/widgets/realized-correlation-widget.js';
import { getWidgetDefinition } from '../src/renderer/widgets/index.js';
import { sourceForWidget } from '../src/shared/data-sources.mjs';

function inputs() {
  const dates = Array.from({ length: 55 }, (_, i) => new Date(Date.UTC(2026, 0, i + 1)))
    .filter((date) => ![0, 6].includes(date.getUTCDay())).map((date) => date.toISOString().slice(0, 10));
  const basket = Array.from({ length: 50 }, (_, i) => ({ symbol: `S${i}`, name: `Company ${i}`, weight: 0.02 }));
  const source = (bars, provider = 'yahoo') => ({ bars, provider, cached: false, updatedAt: '2026-02-25T00:00:00Z' });
  const prices = Object.fromEntries(basket.map(({ symbol }, j) => {
    let close = 100;
    return [symbol, source(dates.map((date, i) => ({ date, close: close *= Math.exp(Math.sin(i * 1.7 + j / 10) * 0.01) })))];
  }));
  return { startDate: dates[0], endDate: dates.at(-1), holdings: { basket, asOf: dates.at(-1), provider: 'ishares', updatedAt: '2026-02-25T00:00:00Z' },
    prices, calendar: source(dates.map((date) => ({ date, close: 100 }))),
    cor1m: source(dates.map((date) => ({ date, close: 25 })), 'cboe'), warnings: [] };
}

function container() {
  const controls = [];
  const button = { addEventListener(_, callback) { this.click = callback; } };
  return { innerHTML: '', controls, button, querySelector: () => button, querySelectorAll: () => controls };
}

function harness(t, handler = async () => inputs()) {
  const previous = global.window;
  const charts = [];
  class Chart {
    constructor(canvas, config) { this.config = config; this.destroyed = false; charts.push(this); }
    destroy() { this.destroyed = true; }
    isDatasetVisible(index) { return !this.config.data.datasets[index].hidden; }
    setDatasetVisibility(index, visible) { this.config.data.datasets[index].hidden = !visible; }
    update() {}
  }
  let calls = 0;
  global.window = { Chart, appBridge: { getRealizedCorrelationInputs: (request) => { calls += 1; return handler(request); } } };
  t.after(() => { global.window = previous; });
  const target = container(); const published = [];
  const widget = { id: 'w-rc', type: definition.type, config: {} };
  const render = () => definition.render({ container: target, widget, widgetData: { publish: (data) => published.push(data) }, onConfigChange: () => {} });
  return { target, widget, published, charts, render, calls: () => calls };
}

test('registry owns no tab datasource and publishes all calculation series', async (t) => {
  const h = harness(t);
  assert.equal(getWidgetDefinition(definition.type).providerKey, null);
  assert.equal(sourceForWidget({ dataSources: [{ providerKey: 'tradingview' }] }, h.widget, getWidgetDefinition), null);
  await h.render();
  assert.equal(h.published[0].status, 'ok');
  assert.equal(h.published[0].basket.length, 50);
  assert.equal(h.published[0].priceMode, 'adjusted');
  assert.equal(h.published[0].config.ewma, true);
  assert.equal(h.published[0].config.ewmaHalfLife, 10);
  assert.equal(h.published[0].ewma.halfLife, 10);
  assert.ok(Number.isFinite(h.published[0].latest.rcEwma));
  assert.equal(h.charts[0].config.data.datasets.length, 5);
  assert.match(h.charts[0].config.data.datasets[3].label, /RC EWMA · H=10/);
  assert.ok(Number.isFinite(h.published[0].latest.spread));
  assert.equal(h.charts.length, 2);
  assert.match(h.target.innerHTML, /current Top 50/);
});

test('legend toggles every main metric, persists visibility and reuses loaded prices', async (t) => {
  const h = harness(t);
  const checkbox = { checked: true };
  h.target.querySelector = (selector) => selector.startsWith('[data-rc-config=') ? checkbox : h.target.button;
  await h.render();
  for (const [index, key] of ['rc5', 'rc10', 'rc21', 'ewma', 'cor1m'].entries()) {
    const chart = h.charts.at(-2);
    chart.config.options.plugins.legend.onClick({}, { datasetIndex: index }, { chart });
    assert.equal(chart.isDatasetVisible(index), false);
    assert.equal(h.widget.config[key], false);
    assert.equal(checkbox.checked, false);
    await h.render();
    const restored = h.charts.at(-2);
    assert.equal(restored.isDatasetVisible(index), false);
    restored.config.options.plugins.legend.onClick({}, { datasetIndex: index }, { chart: restored });
    assert.equal(restored.isDatasetVisible(index), true);
    assert.equal(h.widget.config[key], true);
    assert.equal(checkbox.checked, true);
    await h.render();
  }
  assert.equal(h.calls(), 1);
  // The spread chart keeps the built-in Chart.js legend behavior for its two datasets.
  assert.equal(h.charts.at(-1).config.options.plugins.legend.onClick, undefined);
});

test('EWMA visibility reuses loaded prices and half-life changes request and publish new parameters', async (t) => {
  const requests = [];
  const h = harness(t, async (params) => { requests.push(params); return inputs(); });
  const checkbox = { type: 'checkbox', dataset: { rcConfig: 'ewma' }, checked: false, addEventListener(_, callback) { this.change = callback; } };
  const halfLife = { type: 'number', dataset: { rcConfig: 'ewmaHalfLife' }, value: '5', addEventListener(_, callback) { this.change = callback; } };
  h.target.controls.push(checkbox, halfLife);
  await h.render();
  const original = h.published[0];
  checkbox.change(); await h.render();
  assert.equal(h.calls(), 1);
  assert.equal(h.charts.at(-2).config.data.datasets[3].hidden, true);
  assert.equal(h.widget.config.ewma, false);
  halfLife.change(); await h.render();
  assert.equal(h.widget.config.ewmaHalfLife, 5);
  assert.equal(requests.at(-1).ewmaHalfLife, 5);
  assert.equal(h.calls(), 2);
  assert.equal(h.published.at(-1).ewma.halfLife, 5);
  assert.match(h.charts.at(-2).config.data.datasets[3].label, /H=5/);
  assert.notEqual(h.published.at(-1).latest.rcEwma, original.latest.rcEwma);
  for (const key of ['rc5', 'rc10', 'rc21', 'cor1m', 'spread']) assert.equal(h.published.at(-1).latest[key], original.latest[key]);
});

test('invalid EWMA input is not persisted and malformed saved half-life recovers to ten', async (t) => {
  const h = harness(t);
  let validationError;
  const control = { type: 'number', dataset: { rcConfig: 'ewmaHalfLife' }, value: '64',
    setCustomValidity(value) { validationError = value; }, reportValidity() {}, addEventListener(_, callback) { this.change = callback; } };
  h.target.controls.push(control);
  h.widget.config.ewmaHalfLife = 'bad';
  await h.render();
  assert.equal(h.widget.config.ewmaHalfLife, 10);
  control.change();
  assert.match(validationError, /half-life/);
  assert.equal(h.widget.config.ewmaHalfLife, 10);
  control.value = '1'; control.change();
  assert.equal(validationError, '');
  assert.equal(h.widget.config.ewmaHalfLife, 1);
});

test('unavailable latest EWMA publishes partial and explains its warmup', async (t) => {
  const data = inputs();
  const latest = data.prices.S0.bars.at(-1).date;
  data.prices.S0.bars = data.prices.S0.bars.filter((row) => row.date !== latest);
  const h = harness(t, async () => data);
  await h.render();
  assert.equal(h.published.at(-1).status, 'partial');
  assert.equal(h.published.at(-1).latest.rcEwma, null);
  assert.ok(h.published.at(-1).warnings.some((value) => /EWMA/.test(value)));
});

test('COR1M failure renders RC with a partial dataset and null spread', async (t) => {
  const data = inputs(); data.cor1m = null; data.warnings = ['COR1M unavailable'];
  const h = harness(t, async () => data);
  await h.render();
  assert.equal(h.published[0].status, 'partial');
  assert.equal(h.published[0].latest.spread, null);
  assert.ok(Number.isFinite(h.published[0].latest.rc21));
  assert.match(h.target.innerHTML, /COR1M unavailable/);
});

test('visibility changes reuse loaded data, persist config, and destroy previous charts', async (t) => {
  const h = harness(t);
  const checkbox = { type: 'checkbox', dataset: { rcConfig: 'rc5' }, checked: false, addEventListener(_, callback) { this.change = callback; } };
  h.target.controls.push(checkbox);
  await h.render(); checkbox.change();
  assert.equal(h.widget.config.rc5, false);
  h.widget.config.spread = false;
  await h.render();
  assert.equal(h.calls(), 1);
  assert.ok(h.charts[0].destroyed && h.charts[1].destroyed);
  assert.equal(h.charts.at(-1).config.data.datasets[0].hidden, true);
  assert.equal(h.published.at(-1).config.spread, false);
});

test('Load data forces refresh; error publishes a contract and escapes provider text', async (t) => {
  let request;
  const h = harness(t, async (params) => { request = params; if (params.forceRefresh) throw new Error('<offline>'); return inputs(); });
  await h.render(); h.target.button.click(); await h.render();
  assert.equal(request.forceRefresh, true);
  assert.equal(h.published.at(-1).status, 'error');
  assert.match(h.target.innerHTML, /&lt;offline&gt;/);
});

test('superseded loads and destroyed containers cannot publish or create charts', async (t) => {
  const resolvers = [];
  const h = harness(t, () => new Promise((resolve) => resolvers.push(resolve)));
  const first = h.render();
  h.widget.config.startDate = '2026-01-02';
  const second = h.render();
  resolvers[1](inputs()); await second;
  resolvers[0](inputs()); await first;
  assert.equal(h.published.length, 1);
  assert.equal(h.charts.length, 2);
  h.widget.config.startDate = '2026-01-03';
  const pending = h.render(); definition.destroy(h.target);
  resolvers[2](inputs()); await pending;
  assert.equal(h.published.length, 1);
  assert.equal(h.charts.length, 2);
  assert.ok(h.charts.every((chart) => chart.destroyed));
});
