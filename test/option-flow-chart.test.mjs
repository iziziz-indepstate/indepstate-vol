import test from 'node:test';
import assert from 'node:assert/strict';
import { optionFlowTickWidget, optionFlowBalancedTickWidget } from '../src/renderer/widgets/option-flow-tick-widget.js';
import { gammaFlowWidget, gammaImbalanceWidget } from '../src/renderer/widgets/gamma-flow-widget.js';
import { flowTimeSplits, localFlowTime } from '../src/renderer/widgets/option-flow-chart.js';
import { UPlotWidgetChart, createWidgetCard } from '../src/renderer/widgets/widget-renderers.js';
import { normalizeWidgetParamValue, shouldRefreshOnWidgetParamChange } from '../src/renderer/widgets/widget-params.js';

const definitions = [optionFlowTickWidget, optionFlowBalancedTickWidget, gammaFlowWidget, gammaImbalanceWidget];
const time = (i) => `2026-10-16T13:31:0${i}.000Z`;
function history() {
  return [100, 101, null, 103].map((px, i) => ({
    provider: 'tape-contract', time: time(i), px,
    tape: { records: [{
      underlying: 'SPX', underlying_price: px, strike: 100, expiration: '2026-10-16',
      call_put: 'CALL', aggressor_buy_sell: 'BUY', classification_quality: 'reliable',
      size_contracts: i + 1, gamma: 100, gamma_unit: 'per_point',
      executed_at: time(i), trade_id_sequence: `overlay-${i}`
    }] }
  }));
}

test('underlying config is boolean, refreshes and restores through saved widget config', () => {
  for (const [raw, expected] of [[true, true], [false, false], ['true', true], ['false', false], [undefined, false]]) {
    assert.equal(normalizeWidgetParamValue('showUnderlying', raw), expected);
  }
  assert.equal(shouldRefreshOnWidgetParamChange('showUnderlying'), true);
  const oldDocument = globalThis.document;
  globalThis.document = { createElement: () => ({ dataset: {}, classList: { add() {} } }) };
  try {
    for (const definition of definitions) {
      assert.equal(definition.defaultConfig.showUnderlying, false);
      for (const enabled of [false, true]) {
        const widget = JSON.parse(JSON.stringify({ id: 'flow', type: definition.type, config: { showUnderlying: enabled } }));
        const card = createWidgetCard(widget, definition);
        const checkbox = card.innerHTML.match(/<input type="checkbox"[^>]*data-widget-param-name="showUnderlying"[^>]*>/)?.[0];
        assert.ok(checkbox);
        assert.equal(checkbox.includes('checked'), enabled);
      }
    }
  } finally { globalThis.document = oldDocument; }
});

test('all flow widgets append aligned raw prices without changing flow datasets', () => {
  for (const definition of definitions) {
    for (const flowDisplayMode of ['cumulative', 'linear', 'ma-1m']) {
      const config = { strikeWindow: 'ALL', flowDisplayMode };
      const plain = definition.buildTimeSeries(history(), { config });
      const overlaid = definition.buildTimeSeries(history(), { config: { ...config, showUnderlying: true } });
      assert.equal(overlaid.datasets.length, plain.datasets.length + 1);
      assert.deepEqual(overlaid.datasets.slice(0, -1).map((d) => [d.label, d.data]), plain.datasets.map((d) => [d.label, d.data]));
      const overlay = overlaid.datasets.at(-1);
      assert.equal(overlay.yAxisID, 'underlying');
      assert.deepEqual(overlay.data, plain.datasets[0].pointMeta.map((p) => p[definition.gammaFlow ? 'currentSpot' : 'px']));
      assert.equal(overlay.data.length, overlaid.labels.length);
      assert.deepEqual(overlay.pointMeta.map((p) => p.timestamp), plain.datasets[0].pointMeta.map((p) => p.timestamp));
    }
    for (const input of [[], history().slice(0, 1)]) {
      const built = definition.buildTimeSeries(input, { config: { showUnderlying: true } });
      assert.equal(built.datasets.at(-1).data.length, built.labels.length);
    }
    const noPrice = history().slice(0, 1);
    noPrice[0].px = null;
    noPrice[0].tape.records[0].underlying_price = null;
    assert.deepEqual(definition.buildTimeSeries(noPrice, { config: { showUnderlying: true } }).datasets.at(-1).data, [null]);
  }
  for (const definition of definitions.slice(0, 2)) {
    const built = definition.buildTimeSeries(history(), { config: { showUnderlying: true, displayPointOffset: 1, displayPointLimit: 2 } });
    assert.deepEqual(built.datasets.at(-1).data, [null, 103]);
    assert.deepEqual(built.datasets.at(-1).pointMeta.map((p) => p.timestamp), [time(2), time(3)]);
  }
});

test('local time formatting and responsive splits only label existing observations', () => {
  const date = new Date(time(0));
  const expected = [date.getHours(), date.getMinutes(), date.getSeconds()].map((v) => String(v).padStart(2, '0')).join(':');
  assert.equal(localFlowTime(time(0)), expected);
  assert.equal(localFlowTime('bad'), '');
  assert.equal(localFlowTime(null), '');
  assert.deepEqual(flowTimeSplits({ width: 300 }, 0, 1, 0), []);
  assert.deepEqual(flowTimeSplits({ width: 300 }, -.5, .5, 1), [0]);
  const narrow = flowTimeSplits({ width: 300 }, 1.2, 99.8, 100);
  const wide = flowTimeSplits({ width: 1000 }, 1.2, 99.8, 100);
  assert.ok(wide.length > narrow.length);
  assert.ok([...narrow, ...wide].every((x) => Number.isInteger(x) && x >= 2 && x <= 99));
});

test('uPlot renders the overlay first on its own axis and retains flow visibility on toggles', () => {
  const oldDocument = globalThis.document;
  const oldComputedStyle = globalThis.getComputedStyle;
  const node = () => ({ style: {}, classList: { add() {} }, replaceChildren() {}, clientWidth: 800 });
  globalThis.document = { createElement: node };
  globalThis.getComputedStyle = () => ({ height: '240px' });
  class Plot {
    constructor(options, data) { this.options = options; this.data = data; }
    setData(data) { this.data = data; }
    setSize() {}
    destroy() { this.destroyed = true; }
  }
  try {
    for (const definition of definitions) {
      const chart = new UPlotWidgetChart(Plot, node(), definition);
      const plain = definition.buildTimeSeries(history(), { config: {} });
      chart.data = plain;
      Object.assign(chart.options, plain.chartOptions);
      chart.setDatasetVisibility(0, false);
      chart.update();
      const initialPlot = chart._plot;
      chart.data = definition.buildTimeSeries(history(), { config: { showUnderlying: true } });
      chart.update();
      assert.equal(initialPlot.destroyed, true);
      assert.equal(chart.isDatasetVisible(0), false);
      assert.equal(chart._lastBuild.visible[0].idx, plain.datasets.length);
      const options = chart._plot.options;
      assert.equal(options.series[1].scale, 'underlying');
      assert.equal(options.series[1].spanGaps, false);
      assert.equal(options.scales.underlying.auto, true);
      const priceAxis = options.axes.find((a) => a.scale === 'underlying');
      assert.equal(priceAxis.side, 1);
      assert.deepEqual(priceAxis.values(null, [100.125, 101]), ['100.13', '101.00']);
      assert.equal(priceAxis.grid.show, false);
      assert.equal(options.axes[0].show, true);
      if (definition === gammaImbalanceWidget) {
        assert.ok(options.axes.some((a) => a.scale === 'ivPressure'));
        assert.deepEqual(options.scales.y.range(null, -5, 5), [-1, 1]);
      }
      // The existing plot callbacks must see fresh timestamps and point counts.
      chart.data = definition.buildTimeSeries(history().slice(0, 1), { config: { showUnderlying: true } });
      chart.data.datasets[0].pointMeta = [{ timestamp: time(3) }];
      chart.update();
      assert.deepEqual(options.axes[0].splits({ width: 800 }, 0, 0, 3), [0]);
      assert.deepEqual(options.axes[0].values(null, [0]), [localFlowTime(time(3))]);
      chart.data = plain;
      chart.update();
      assert.equal(chart.isDatasetVisible(0), false);
      assert.equal(chart._plot.options.axes.some((a) => a.scale === 'underlying'), false);
      assert.equal(chart._plot.options.scales.underlying, undefined);
      chart.destroy();
    }
  } finally {
    globalThis.document = oldDocument;
    globalThis.getComputedStyle = oldComputedStyle;
  }
});
