import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateZeroDteSkewPoint, resolveSkewExpiration } from '../src/shared/zero-dte-skew-calculations.mjs';
import { zeroDteSkewWidget } from '../src/renderer/widgets/zero-dte-skew-widget.js';
import { getWidgetDefinition } from '../src/renderer/widgets/index.js';
import { trimSnapshotForWidgets } from '../src/shared/snapshot-trim.mjs';
import { normalizeWidgetParamValue, WIDGET_PARAM_NAMES } from '../src/renderer/widgets/widget-params.js';

const q = (type, strike, delta, iv) => ({ type, strike, delta, iv, bid: 1, ask: 1.2 });
function snapshot() {
  const expiry = '20261022';
  const chain = { px: 100, optionQuotes: [
    q('put', 100, -0.5, 0.2), q('call', 100, 0.5, 0.2),
    q('put', 90, -0.25, 0.24), q('call', 110, 0.25, 0.21),
    q('put', 85, -0.1, 0.27), q('call', 115, 0.1, 0.23)
  ] };
  return { time: '2026-10-22T15:00:00Z', expiry, px: 100, ...chain, byExpiry: { [expiry]: chain } };
}
const near = (value, expected) => assert.ok(Math.abs(value - expected) < 1e-10, `${value} != ${expected}`);

test('exact delta, ATM and chart vol-point units follow the specified signs', () => {
  const p = calculateZeroDteSkewPoint(snapshot());
  near(p.skew, 0.03); near(p.putWing, 0.04); near(p.callWing, 0.01);
  assert.equal(p.atmStrike, 100);
  assert.equal(p.put.contracts.length, 1);
  const series = zeroDteSkewWidget.buildTimeSeries([snapshot()], {});
  [3, 4, 1].forEach((v, i) => near(series.datasets[i].data[0], v));
  assert.match(series.datasets[0].tooltipFormatter({ dataset: series.datasets[0], dataIndex: 0 }).join('\n'), /3.00 vol pts/);
});

test('interpolates each side by absolute delta and never extrapolates', () => {
  const p = calculateZeroDteSkewPoint(snapshot(), { targetDelta: 0.175 });
  near(p.put.iv, 0.255); near(p.call.iv, 0.22);
  assert.equal(p.put.contracts.length, 2);
  const missing = calculateZeroDteSkewPoint(snapshot(), { targetDelta: 0.05 });
  assert.equal(missing.skew, null);
  assert.equal(missing.put.iv, null);
});

test('invalid and empty quote fields are excluded without conversion to zero', () => {
  for (const bad of [
    { bid: null }, { ask: '' }, { iv: null }, { iv: 0 }, { strike: '' }, { delta: null },
    { ask: 0.5 }, { bid: -1 }, { delta: Infinity }, { iv: NaN }
  ]) {
    const s = snapshot();
    Object.assign(s.byExpiry[s.expiry].optionQuotes[2], bad);
    const p = calculateZeroDteSkewPoint(s);
    assert.equal(p.put.iv, null, JSON.stringify(bad));
    assert.equal(p.skew, null);
    near(p.callWing, 0.01);
  }
});

test('ATM requires both sides; skew remains available without an ATM pair', () => {
  const s = snapshot();
  s.byExpiry[s.expiry].optionQuotes = s.byExpiry[s.expiry].optionQuotes.filter((q) => q.strike !== 100);
  const p = calculateZeroDteSkewPoint(s);
  assert.equal(p.atmIV, null);
  assert.equal(p.putWing, null);
  near(p.skew, 0.03);
});

test('ATM ties select the lower strike, OTM selection excludes ITM quotes', () => {
  const s = snapshot();
  s.byExpiry[s.expiry].px = 105;
  s.byExpiry[s.expiry].optionQuotes.push(q('put', 110, -0.25, 0.9));
  const p = calculateZeroDteSkewPoint(s);
  assert.equal(p.atmStrike, 100);
  near(p.put.iv, 0.24);
});

test('today uses snapshot New York date, ignores placeholders, and does not roll to tomorrow', () => {
  const s = snapshot();
  s.time = '2026-10-23T01:00:00Z';
  s.expiryPlaceholders = { today: '20261023' };
  assert.equal(resolveSkewExpiration(s), '20261022');
  assert.equal(calculateZeroDteSkewPoint(s).expiration, '20261022');
  s.time = '2026-10-24T15:00:00Z';
  assert.equal(calculateZeroDteSkewPoint(s).skew, null);
  near(calculateZeroDteSkewPoint(s, { expiration: '2026-10-22' }).skew, 0.03);
  assert.equal(resolveSkewExpiration({ time: '2026-01-23T04:30:00Z' }), '20260122');
  assert.equal(resolveSkewExpiration({ time: 'invalid' }), '');
});

test('session and expiry boundaries insert nulls even with explicit expiration', () => {
  const a = snapshot(), b = snapshot();
  b.time = '2026-10-23T15:00:00Z';
  const series = zeroDteSkewWidget.buildTimeSeries([a, b], { config: { expiration: a.expiry } });
  assert.equal(series.datasets[0].data.length, 3);
  assert.equal(series.datasets[0].data[1], null);
  near(series.datasets[0].data[2], 3);
});

test('compact history preserves all quotes and recomputes after saved delta changes', () => {
  const s = snapshot();
  const widget = { id: 'skew', type: 'zero-dte-skew', config: { ...zeroDteSkewWidget.defaultConfig } };
  const compact = trimSnapshotForWidgets(s, { widgets: [widget] });
  assert.equal(compact.byExpiry[s.expiry].optionQuotes.length, s.byExpiry[s.expiry].optionQuotes.length);
  for (const targetDelta of [0.25, 0.175, 0.1]) {
    widget.config.targetDelta = targetDelta;
    const saved = JSON.parse(JSON.stringify(widget));
    assert.deepEqual(calculateZeroDteSkewPoint(compact, saved.config), calculateZeroDteSkewPoint(s, saved.config));
  }
  const missing = snapshot();
  delete missing.byExpiry[missing.expiry].optionQuotes;
  assert.equal(calculateZeroDteSkewPoint(missing).skew, null);
});

test('registered widget and parameter limits preserve the existing n-Delta range', () => {
  assert.equal(getWidgetDefinition('zero-dte-skew'), zeroDteSkewWidget);
  const normalize = (value, options) => normalizeWidgetParamValue(WIDGET_PARAM_NAMES.TARGET_DELTA, value, 0.25, options);
  assert.equal(normalize(0.8, { targetDeltaMax: 0.49 }), 0.49);
  assert.equal(normalize(0.8), 0.8);
  assert.equal(normalize(-0.1, { targetDeltaMax: 0.49 }), 0.1);
  const series = zeroDteSkewWidget.buildTimeSeries([], { config: { targetDelta: 0.1 } });
  assert.match(series.title, /10Δ/);
  assert.match(series.chartOptions.skewStatus, /No option-chain history/);
});
