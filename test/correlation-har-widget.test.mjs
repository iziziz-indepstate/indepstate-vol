import test from 'node:test';
import assert from 'node:assert/strict';
import { correlationHarWidget as definition } from '../src/renderer/widgets/correlation-har-widget.js';
import { getWidgetDefinition } from '../src/renderer/widgets/index.js';
import { sourceForWidget } from '../src/shared/data-sources.mjs';

const record = { date: '2026-10-01', issuedAt: '2026-10-01T21:00:00Z', basketAsOf: '2026-10-01', forecast: 30, cor1m: 20, spread: 10,
  factors: { rc21: 29, rcEwma: 28 }, training: { samples: 1260 }, coefficients: { intercept: 1 }, targetEndDate: '2026-10-30', fact: 25, error: 5 };
function harness(t, handler = async () => ({ status: 'ok', latest: record, records: [record], warnings: [], sources: {}, directory: 'Data', checkedAt: '2026-11-18' })) {
  const previous = global.window, charts = [], requests = [], published = [];
  global.window = { Chart: class {
    constructor(_, config) { this.config = config; charts.push(this); }
    destroy() { this.destroyed = true; }
  }, appBridge: { getCorrelationHarState: (params) => { requests.push(params); return handler(params); } } };
  const button = { addEventListener(_, callback) { this.click = callback; } };
  const target = { innerHTML: '', querySelector: () => button };
  const widget = { type: definition.type, config: {} };
  const render = () => definition.render({ container: target, widget, widgetData: { publish: (data) => published.push(data) } });
  t.after(() => { definition.destroy(target); global.window = previous; });
  return { target, widget, button, render, charts, requests, published };
}
test('independent widget plots issued forecasts, facts and COR1M at origin dates and publishes its contract', async (t) => {
  const h = harness(t);
  assert.equal(getWidgetDefinition(definition.type).providerKey, null);
  assert.equal(sourceForWidget({ dataSources: [{ providerKey: 'tradingview' }] }, h.widget, getWidgetDefinition), null);
  await h.render();
  assert.deepEqual(h.charts[0].config.data.labels, [record.date]);
  assert.deepEqual(h.charts[0].config.data.datasets.map((row) => row.data), [[30], [25], [20]]);
  assert.equal(h.published[0].type, 'correlation-har');
  assert.equal(h.published[0].status, 'ok');
  assert.match(h.target.innerHTML, /1260/);
  assert.match(h.charts[0].config.options.plugins.tooltip.callbacks.afterBody([{ dataIndex: 0 }]).join(' '), /2026-10-30/);
  await h.button.click();
  assert.equal(h.requests.at(-1).refresh, true);
  assert.equal(h.charts[0].destroyed, true);
});
test('saved archive remains visible with partial errors and pending facts are null', async (t) => {
  const pending = { ...record, fact: null, error: null, targetEndDate: null };
  const h = harness(t, async () => ({ status: 'partial', latest: pending, records: [pending], error: 'offline', warnings: ['stale'], sources: {} }));
  await h.render();
  assert.equal(h.published[0].status, 'partial');
  assert.deepEqual(h.charts[0].config.data.datasets[1].data, [null]);
  assert.match(h.target.innerHTML, /offline/);
  assert.match(h.target.innerHTML, /30.00/);
});
test('destroy prevents pending requests from rendering or publishing', async (t) => {
  let resolve;
  const h = harness(t, () => new Promise((done) => { resolve = done; }));
  const rendering = h.render();
  definition.destroy(h.target);
  resolve({ latest: record, records: [record], status: 'ok' });
  await rendering;
  assert.equal(h.charts.length, 0);
  assert.equal(h.published.length, 0);
});
