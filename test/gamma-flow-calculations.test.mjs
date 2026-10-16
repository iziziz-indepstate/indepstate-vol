import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateGammaFlow, createGammaFlowCalculator, confirmedImbalance, captureGammaAnchor, gammaScopeKey, executionMs, normalizeGammaParam } from '../src/shared/gamma-flow-calculations.mjs';
import { trimSnapshotForWidgets } from '../src/shared/snapshot-trim.mjs';
import { gammaFlowWidget, gammaImbalanceWidget } from '../src/renderer/widgets/gamma-flow-widget.js';
import { buildOptionFlowTickSeries } from '../src/shared/option-flow-tick-calculations.mjs';
import { gammaControlVisible, gammaFlowControls, syncGammaFlowControls } from '../src/renderer/widgets/gamma-flow-controls.js';

const start = '2026-10-16T13:30:00.000Z';
const time = '2026-10-16T13:31:00.000Z';
const end = '2026-10-16T20:00:00.000Z';
const at = (minutes) => new Date(Date.parse(start) + minutes * 60000).toISOString();
export function tape(id, overrides = {}) {
  return { underlying: 'SPX', expiration: '2026-10-16', strike: 100, call_put: 'CALL',
    aggressor_buy_sell: 'BUY', classification_quality: 'reliable', size_contracts: 1,
    gamma: overrides.aggressor_buy_sell === 'SELL' ? -100 : 100, gamma_unit: 'per_point', underlying_price: 100, executed_at: time,
    trade_id_sequence: id, _sentAt: time, ...overrides };
}
export function quote(strike = 100, overrides = {}) {
  return { underlying: 'SPX', expiration: '2026-10-16', strike, call_put: 'CALL', timestamp: time,
    expiration_at: end, gamma: 100, gamma_unit: 'per_point', iv: .2, iv_unit: 'decimal',
    underlying_price: 100, forward: 100, quality: 'reliable', ...overrides };
}
export function snap(t = time, rows = [], quotes = [], calibrations = []) {
  return { provider: 'tape-contract', time: t, tape: { records: rows, count: rows.length },
    quote: { records: quotes }, calibration: { records: calibrations }, contract: { records: [] } };
}
export function calibration(segment, overrides = {}, cfg = {}) {
  return { underlying: 'SPX', expiration: '2026-10-16', timestamp: time, expiration_at: end,
    quality: 'reliable', segment, scope_key: gammaScopeKey(cfg), gamma_mode: 'executed',
    option_types: 'total', window_start: start, window_end: time, iv_unit: 'decimal',
    historical: true, sample_count: 100, tod_start_minute: 0, tod_end_minute: 1440,
    min_seconds_to_expiry: 0, max_seconds_to_expiry: 86400, iv_scale: .01, skew_scale: .01,
    activity_threshold: 10, adjusted_iv_change: .01, comparable_iv_start: .2,
    comparable_iv_end: .21, comparison_method: 'constant_forward_moneyness_adjusted', ...overrides };
}
const last = (history, cfg) => calculateGammaFlow(history, cfg).at(-1);

test('equal gamma purchases and sales cancel; bought calls and puts have the same sign', () => {
  let p = last([snap(time, [tape('a'), tape('b', { aggressor_buy_sell: 'SELL' })])]);
  assert.equal(p.net, 0); assert.equal(p.B, 0); assert.equal(p.gross, 200);
  p = last([snap(time, [tape('a'), tape('b', { call_put: 'PUT' })])]);
  assert.equal(p.net, 200); assert.equal(p.calls.net, 100); assert.equal(p.puts.net, 100);
});

test('confirmation respects signs, bounds, zero pressure and missing values', () => {
  for (const b of [-1, -.5, 0, .5, 1]) {
    for (const z of [-20, -1, 0, 1, 20]) {
      const c = confirmedImbalance(b, z);
      assert.ok(Math.abs(c) <= 1 && Math.abs(c) <= Math.abs(b));
      assert.ok(c === 0 || Math.sign(c) === Math.sign(b));
    }
    assert.equal(confirmedImbalance(b, 0), b / 2);
  }
  assert.ok(confirmedImbalance(.8, 1) > confirmedImbalance(.8, -1));
  assert.ok(confirmedImbalance(-.8, -1) < confirmedImbalance(-.8, 1));
  assert.equal(confirmedImbalance(null, 1), null);
});

test('executed values stay fixed; revaluation changes without new trades and decomposes movement', () => {
  const history = [snap(time, [tape('a')], [quote()]),
    snap(at(2), [], [quote(100, { timestamp: at(2), gamma: 200, underlying_price: 110 })])];
  assert.deepEqual(calculateGammaFlow(history).map((p) => p.net), [100, 100]);
  const p = last(history, { gammaMode: 'revalued' });
  assert.equal(p.net, 200); assert.equal(p.newFlow, 0); assert.equal(p.revaluation, 100);
  assert.equal(last([history[0], snap(at(3))], { gammaMode: 'revalued' }).net, null);
});

test('rolling uses execution timestamps and an exclusive lower bound, never accumulating sums again', () => {
  const h = [snap(start), snap(time, [tape('a')]), snap(at(2), [tape('b', { executed_at: at(2) })]), snap(at(3))];
  const points = calculateGammaFlow(h, { gammaWindow: 'rolling', gammaMinutes: 1 });
  assert.deepEqual(points.map((p) => p.net), [null, 100, 100, null]);
  assert.equal(points.at(-1).B, null);
  assert.equal(last(h, { gammaWindow: 'anchored', gammaStart: time }).net, 200);
});

test('dynamic ATM membership and segment are frozen when current spot moves', () => {
  const h = [snap(start, [], [90, 100, 110].map((k) => quote(k, { timestamp: start }))),
    snap(time, [tape('a')]), snap(at(2), [], [quote(110, { timestamp: at(2), underlying_price: 110 })])];
  const p = last(h, { gammaWidth: 0 });
  assert.equal(p.net, 100); assert.equal(p.segments.atm.net, 100);
  const anchor = captureGammaAnchor(h, time);
  assert.equal(anchor.atm, 100); assert.deepEqual(anchor.strikes, [90, 100, 110]);
  const anchored = { gammaStrikeScope: 'anchored', gammaAnchorAt: time, gammaAnchorStrike: 100, gammaAnchorStrikes: '90,100,110', gammaWidth: 0 };
  assert.equal(last([...h, snap(at(3), [tape('b', { strike: 110, underlying_price: 110, executed_at: at(3) })])], anchored).net, 100);
  assert.equal(last(h, { gammaStrikeScope: 'anchored' }).net, null);
});

test('explicit strike lists/ranges and option / quality filters', () => {
  const h = [snap(time, [tape('a'), tape('b', { strike: 105, call_put: 'PUT', classification_quality: 'unknown' })])];
  assert.equal(last(h, { gammaStrikeScope: 'explicit', gammaStrikes: '105' }).net, 100);
  assert.equal(last(h, { gammaStrikeScope: 'explicit', gammaStrikes: '99:101' }).net, 100);
  assert.equal(last(h, { gammaOptionTypes: 'put', gammaQuality: 'reliable' }).net, null);
});

test('signed gamma accepts unknown sides; missing gamma and unreadable times are excluded', () => {
  const h = [snap(time, [tape('a', { complex_order_id: 'spread' }),
    tape('b', { aggressor_buy_sell: 'SELL', complex_order_id: 'spread' }),
    tape('c', { aggressor_buy_sell: 'UNKNOWN' }), tape('d', { gamma: null }),
    tape('e', { executed_at: 'not a timestamp' }), tape('f', { expiration: '2026-10-17' })])];
  const p = last(h);
  assert.equal(p.net, 100); assert.equal(p.gross, 300);
  assert.deepEqual(p.excluded, { gamma: 1, execution_time: 1, not_0dte: 1 });
  assert.equal(last([snap(time, [tape('x', { gamma: null })])]).net, null);
});

test('timestamps resolve date and DST in the supplied zone; no receipt-time substitution', () => {
  assert.equal(executionMs({ timestamp: '09:31:00.000', timezone: 'America/New_York', _sentAt: time }), Date.parse(time));
  assert.equal(executionMs({ timestamp: '09:31:00.123', timezone: 'America/New_York', _sentAt: time }), Date.parse(time) + 123);
  assert.equal(executionMs({ timestamp: '09:31:00.000', timezone: 'America/New_York', _sentAt: '2026-01-16T14:32:00Z' }), Date.parse('2026-01-16T14:31:00Z'));
  assert.equal(executionMs({ timestamp: '09:31:00.000' }), null);
});

test('duplicates do not double count; late older quotes cannot replace current quotes', () => {
  const h = [snap(time, [tape('a')], [quote()]), snap(at(2), [tape('a')], [quote(100, { timestamp: at(2), gamma: 200 })]),
    snap(at(2.5), [], [quote(100, { timestamp: time, gamma: 1 })])];
  const p = last(h, { gammaMode: 'revalued' });
  assert.equal(p.net, 200); assert.equal(p.excluded.duplicate, 1);
});

test('calibrated IV pressure weights segments by gross gamma and refuses mismatched context', () => {
  const h = [snap(start), snap(time, [tape('a')], [quote()], [calibration('atm')])];
  let p = last(h);
  assert.equal(p.Z, 1); assert.ok(p.C > .5); assert.equal(p.activity, 'sufficient');
  for (const override of [{ iv_scale: null }, { historical: false }, { window_start: at(-1) },
    { scope_key: 'wrong' }, { gamma_mode: 'revalued' }, { min_seconds_to_expiry: 999999 },
    { tod_start_minute: 1000 }, { option_types: 'put' }, { adjusted_iv_change: null }]) {
    p = last([snap(start), snap(time, [tape('a')], [quote()], [calibration('atm', override)])]);
    assert.equal(p.C, null, JSON.stringify(override)); assert.equal(p.B, 1);
  }
  p = last([snap(start), snap(time, [tape('a')], [quote()], [calibration('atm', { activity_threshold: 1000 })])]);
  assert.equal(p.activity, 'low');
});

test('relative skew changes distinguish downside and upside demand; incomplete segments yield N/A', () => {
  function run(rising) {
    const quotes = [90, 100, 110].map((k) => quote(k));
    const rows = [90, 100, 110].map((k) => tape(String(k), { strike: k }));
    const c = ['downside', 'atm', 'upside'].map((s) => calibration(s, { comparable_iv_end: s === rising ? .23 : .2 }));
    return last([snap(start, [], quotes.map((q) => ({ ...q, timestamp: start }))), snap(time, rows, quotes, c)]);
  }
  const d = run('downside'), u = run('upside');
  assert.ok(d.A < 0); assert.ok(u.A > 0);
  assert.ok(d.deltaDownsideUpsideSkew > 0); assert.ok(u.deltaDownsideUpsideSkew < 0);
  assert.equal(last([snap(time, [tape('a')], [quote()], [calibration('atm')])]).A, null);
});

test('empty data never creates a confirmed or balanced zero and reports history coverage', () => {
  const p = last([snap(time)]);
  assert.equal(p.B, null); assert.equal(p.C, null); assert.equal(p.A, null); assert.equal(p.net, null);
  assert.equal(p.completeCoverage, false);
  assert.equal(last([snap(start), snap(time)]).completeCoverage, true);
});

test('raw/compact histories calculate identically and preserve evidence and trade provenance', () => {
  const raw = [snap(start), snap(time, [tape('a', { iv: '20%', complex_order_id: 'abc' })], [quote()], [calibration('atm')])];
  const compact = raw.map((s) => trimSnapshotForWidgets(s, { widgets: [{ type: 'option-flow-gamma-flow' }] }));
  assert.deepEqual(calculateGammaFlow(compact), calculateGammaFlow(raw));
  assert.equal(compact[1].tape.records[0].complex_order_id, 'abc');
  assert.deepEqual(trimSnapshotForWidgets(compact[1], { widgets: [] }), compact[1]);
});

test('widgets share the same metrics, persist JSON config, emit gaps and keep Z on a separate axis', () => {
  const h = [snap(start), snap(time, [tape('a')], [quote()], [calibration('atm')])];
  const cfg = JSON.parse(JSON.stringify({ ...gammaFlowWidget.defaultConfig, gammaWidth: 5 }));
  const flow = gammaFlowWidget.buildTimeSeries(h, { config: cfg });
  const imbalance = gammaImbalanceWidget.buildTimeSeries(h, { config: cfg });
  assert.deepEqual(flow.datasets[0].pointMeta, imbalance.datasets[0].pointMeta);
  assert.equal(flow.datasets[0].data[0], null);
  assert.equal(imbalance.datasets.find((d) => d.seriesKey === 'Z').yAxisID, 'ivPressure');
  assert.match(flow.chartOptions.gammaSummary, /Incomplete|Window covered/);
  assert.equal(normalizeGammaParam('gammaWidth', '-1', 3), 3);
  assert.equal(normalizeGammaParam('gammaStart', 'invalid', ''), '');
  assert.equal(normalizeGammaParam('gammaOptionTypes', 'total'), 'total');
});

test('gamma-only clock points do not change existing TICK widgets', () => {
  const h = [snap(time, [tape('a')])];
  assert.deepEqual(buildOptionFlowTickSeries([...h, { ...snap(at(2)), gammaClock: true }]), buildOptionFlowTickSeries(h));
});

test('incremental calculations match full replay after appends, retention trimming and settings changes', () => {
  const cached = createGammaFlowCalculator();
  const history = [snap(start), snap(time, [tape('a')], [quote()])];
  for (const cfg of [{}, { gammaMode: 'revalued' }, { gammaWindow: 'rolling', gammaMinutes: 1 }]) {
    assert.deepEqual(cached(history, cfg), calculateGammaFlow(history, cfg));
  }
  history.push(snap(at(2), [tape('b', { executed_at: at(2) })], [quote(100, { timestamp: at(2), gamma: 200 })]));
  for (const cfg of [{}, { gammaMode: 'revalued' }, { gammaWindow: 'rolling', gammaMinutes: 1 }]) {
    assert.deepEqual(cached(history, cfg), calculateGammaFlow(history, cfg));
    assert.deepEqual(cached(history, cfg), calculateGammaFlow(history, cfg));
  }
  history.shift();
  assert.deepEqual(cached(history), calculateGammaFlow(history));
});

test('transport latency does not change the IV measurement window; future quotes cannot leak into it', () => {
  const h = [snap(start), snap(at(1.1), [tape('a')], [quote(), quote(100, { timestamp: at(1.05), gamma: 5000 })], [calibration('atm')])];
  const p = last(h);
  assert.equal(p.timestamp, time); assert.equal(p.receivedAt, at(1.1)); assert.equal(p.Z, 1);
  const cfg = { gammaMode: 'revalued' };
  h[1].calibration.records = [calibration('atm', { gamma_mode: 'revalued', scope_key: gammaScopeKey(cfg) })];
  assert.equal(last(h, cfg).net, 100);
  const advanced = last([...h, { ...snap(at(2)), gammaClock: true }], cfg);
  assert.equal(advanced.C, null); assert.equal(advanced.net, 5000);
});

test('latest SPX tape spot reprices all contracts independently of widget filters and quote spot', () => {
  const cfg = { gammaMode: 'revalued', gammaOptionTypes: 'call', gammaWidth: 0 };
  const h = [snap(time, [tape('a')], [quote(100, { underlying_price: null })]),
    snap(at(1.5), [tape('outside', { executed_at: at(1.5), expiration: '2026-10-17',
      strike: 200, call_put: 'PUT', gamma: null, aggressor_buy_sell: 'UNKNOWN', underlying_price: '$110.00' })],
    [quote(100, { timestamp: at(1.5), underlying_price: 999 })])];
  const cached = createGammaFlowCalculator();
  const p = cached(h, cfg).at(-1);
  assert.equal(p.currentSpot, 110); assert.equal(p.currentSpotTimestamp, at(1.5));
  assert.equal(p.currentSpotSource, 'tape.underlying_price');
  assert.equal(p.net, 100); assert.equal(p.newFlow, 0);
  assert.equal(p.revaluation, 0);
  assert.equal(last(h).net, 100);
  h.push(snap(at(1.6), [tape('old', { executed_at: at(1.1), underlying_price: 90, gamma: null }),
    tape('invalid', { executed_at: at(1.6), underlying_price: '', gamma: null }),
    tape('other-symbol', { executed_at: at(1.6), underlying: 'SPY', underlying_price: 10 })]));
  assert.equal(cached(h, cfg).at(-1).currentSpot, 110);
  assert.deepEqual(cached(h, cfg), calculateGammaFlow(h, cfg));
  const compact = h.map((s) => trimSnapshotForWidgets(s, { widgets: [{ type: 'option-flow-gamma-flow' }] }));
  assert.deepEqual(calculateGammaFlow(compact, cfg), calculateGammaFlow(h, cfg));
  h.push(snap(at(1.7)));
  assert.equal(cached(h, cfg).at(-1).currentSpot, 110);
});

test('tape spot obeys measurement time and anchored ATM also uses tape instead of quote spot', () => {
  const h = [snap(start, [], [90, 100, 110].map((k) => quote(k, { timestamp: start, underlying_price: 999 }))),
    snap(at(1.1), [tape('a'), tape('later', { executed_at: at(1.05), underlying_price: 120, gamma: null })],
      [quote(100, { underlying_price: null })], [calibration('atm', { gamma_mode: 'revalued' })])];
  const p = last(h, { gammaMode: 'revalued' });
  assert.equal(p.timestamp, time); assert.equal(p.currentSpot, 100); assert.equal(p.net, 100);
  assert.equal(captureGammaAnchor(h, at(1.1)).atm, 110);
  assert.equal(last([...h, snap(at(1.2))], { gammaMode: 'revalued' }).currentSpot, 120);
});

test('flow, raw imbalance and revaluation do not require calibration in any time-window mode', () => {
  const history = [snap(start), snap(time, [tape('a')], [quote()])];
  for (const gammaMode of ['executed', 'revalued']) {
    for (const window of [{ gammaWindow: 'session' }, { gammaWindow: 'rolling', gammaMinutes: 5 },
      { gammaWindow: 'anchored', gammaStart: start }]) {
      const cfg = { gammaMode, ...window };
      const p = last(history, cfg);
      assert.equal(p.net, 100); assert.equal(p.gross, 100); assert.equal(p.bought, 100); assert.equal(p.sold, 0);
      assert.equal(p.B, 1); assert.equal(p.reason, null);
      assert.equal(p.activity, 'uncalibrated');
      for (const name of ['Z', 'C', 'A']) assert.equal(p[name], null);
      const flow = gammaFlowWidget.buildTimeSeries(history, { config: cfg });
      assert.equal(flow.datasets[0].data.at(-1), 100);
      assert.doesNotMatch(flow.chartOptions.gammaSummary, /IV Pressure|Confirmed C|Missing matching historical calibration/);
      const tooltip = flow.datasets[0].tooltipFormatter({ dataIndex: 1 }).join('\n');
      assert.doesNotMatch(tooltip, /IV confirmation|Missing matching historical calibration/);
      const imbalance = gammaImbalanceWidget.buildTimeSeries(history, { config: cfg });
      assert.equal(imbalance.datasets.find((s) => s.seriesKey === 'B').data.at(-1), 1);
      assert.match(imbalance.chartOptions.gammaSummary, /IV confirmation unavailable:/);
    }
  }
});

test('historical activity threshold is optional even when IV confirmation is available', () => {
  const p = last([snap(start), snap(time, [tape('a')], [quote()], [calibration('atm', { activity_threshold: null })])]);
  assert.equal(p.net, 100); assert.equal(p.B, 1); assert.equal(p.Z, 1);
  assert.ok(p.C > .5); assert.equal(p.activity, 'uncalibrated');
});

test('strike/time/ATM anchor fields are optional and inactive outside their matching modes', () => {
  const h = [snap(start), snap(time, [tape('a')])];
  for (const gammaWindow of ['session', 'rolling']) {
    const p = last(h, { gammaWindow, gammaStrikes: '', gammaAnchorAt: '', gammaAnchorStrike: '', gammaAnchorStrikes: '', gammaStart: '' });
    assert.equal(p.net, 100); assert.equal(p.reason, null);
  }
  const unrelated = last(h, { gammaStrikes: 'bad', gammaAnchorAt: 'bad', gammaStart: 'bad' });
  assert.equal(unrelated.net, 100);
  assert.equal(last(h, { gammaStrikeScope: 'explicit', gammaStrikes: '' }).reason, 'Explicit strikes are empty or invalid');
  assert.equal(last(h, { gammaStrikeScope: 'anchored' }).reason, 'ATM anchor is unavailable');
  assert.equal(last(h, { gammaWindow: 'anchored' }).reason, 'Invalid, missing or future time anchor');
});

test('controls expose only fields relevant to the selected modes, including after switching', () => {
  for (const name of ['gammaStrikes', 'gammaAnchorAt', 'gammaStart', 'gammaMinutes', 'gammaQuoteMaxAgeSeconds']) {
    assert.equal(gammaControlVisible(name), false, name);
  }
  assert.equal(gammaControlVisible('gammaStrikes', { gammaStrikeScope: 'explicit' }), true);
  assert.equal(gammaControlVisible('gammaWidth', { gammaStrikeScope: 'explicit' }), false);
  assert.equal(gammaControlVisible('gammaAnchorAt', { gammaStrikeScope: 'anchored' }), true);
  assert.equal(gammaControlVisible('gammaStart', { gammaWindow: 'anchored' }), true);
  assert.equal(gammaControlVisible('gammaMinutes', { gammaWindow: 'rolling' }), true);
  assert.equal(gammaControlVisible('gammaQuoteMaxAgeSeconds', {}, true), true);
  assert.match(gammaFlowControls({ id: 'test', config: {} }, false), /data-gamma-control="gammaStart"[^>]*hidden/);
  const own = { dataset: { gammaWidgetId: 'test', gammaControl: 'gammaStrikes' }, hidden: false };
  const other = { dataset: { gammaWidgetId: 'other', gammaControl: 'gammaStrikes' }, hidden: false };
  const root = { querySelectorAll: () => [own, other] };
  syncGammaFlowControls(root, { id: 'test', config: {} }, false);
  assert.equal(own.hidden, true); assert.equal(other.hidden, false);
  syncGammaFlowControls(root, { id: 'test', config: { gammaStrikeScope: 'explicit' } }, false);
  assert.equal(own.hidden, false);
});

test('premarket Session and missing execution timestamps do not blame optional time anchors', () => {
  const premarket = '2026-10-16T08:16:00.000Z';
  const missingTime = tape('missing', { executed_at: '', timestamp: '', _sentAt: premarket });
  const h = [snap(premarket, [missingTime])];
  const p = last(h);
  assert.equal(p.reason, 'Regular session has not opened (09:30 America/New_York)');
  assert.equal(p.excluded.execution_time, 1);
  const flow = gammaFlowWidget.buildTimeSeries(h, { config: {} });
  assert.match(flow.chartOptions.gammaSummary, /check tape timestamp \/ executed_at/);
  assert.doesNotMatch(flow.chartOptions.gammaSummary, /missing time anchor/i);
});

test('tape timestamp is authoritative regardless of whether the dump was saved before or after it', () => {
  const source = '2026-10-16T15:24:52.000Z';
  const row = tape('signed-dump', { timestamp: '11:24:52.000', timezone: 'America/New_York',
    executed_at: '2026-10-16T08:25:00Z', _sentAt: '2026-10-16T08:25:00Z' });
  assert.equal(executionMs(row), Date.parse(source));
  for (const receipt of ['2026-10-16T08:25:05.000Z', '2026-10-16T18:00:00.000Z']) {
    for (const gammaMode of ['executed', 'revalued']) {
      const p = last([snap(receipt, [row], [quote(100, { timestamp: source })])], { gammaMode });
      assert.equal(p.timestamp, source); assert.equal(p.receivedAt, receipt);
      assert.equal(p.net, 100); assert.equal(p.reason, null); assert.equal(p.excluded.execution_time, undefined);
      assert.equal(p.currentSpotTimestamp, source);
    }
  }
});

test('time-only historical 0DTE dumps use their own date, and empty polls advance their source clock', () => {
  const row = tape('replay', { timestamp: '11:24:52.000', executed_at: '', expiration: '2026-10-15',
    _sentAt: '2026-10-16T08:25:00Z' });
  const h = [snap('2026-10-16T08:25:00.000Z', [row]), snap('2026-10-16T08:26:00.000Z')];
  const p = calculateGammaFlow(h, { gammaWindow: 'rolling', gammaMinutes: 1 });
  assert.equal(p[0].timestamp, '2026-10-15T15:24:52.000Z'); assert.equal(p[0].net, 100);
  assert.equal(p[1].timestamp, '2026-10-15T15:25:52.000Z'); assert.equal(p[1].net, null);
  assert.equal(p[0].expiration, '2026-10-15');
  assert.equal(executionMs({ timestamp: '2026-10-15 11:24:52', timezone: 'America/New_York' }), Date.parse('2026-10-15T15:24:52Z'));
});

test('replay speed and gaps between recorder snapshots do not shift timestamps of new executions', () => {
  const p = calculateGammaFlow([
    snap('2026-10-16T08:00:00Z', [tape('first', { timestamp: time })]),
    snap('2026-10-16T18:00:00Z', [tape('second', { timestamp: at(2) })])
  ]);
  assert.equal(p[0].timestamp, time); assert.equal(p[1].timestamp, at(2));
  assert.equal(p[1].net, 200);
});

test('source gamma already includes size and sign: sum it directly and never re-sign from BUY/SELL', () => {
  const history = [snap(time, [
    tape('a', { gamma: 7200, size_contracts: 500, underlying_price: 7760, aggressor_buy_sell: 'SELL' }),
    tape('b', { gamma: -1500, size_contracts: 200, underlying_price: 7700, call_put: 'PUT', aggressor_buy_sell: 'BUY' }),
    tape('c', { gamma: -9000, size_contracts: null, aggressor_buy_sell: 'UNKNOWN' })
  ])];
  const p = last(history);
  assert.equal(p.net, -3300); assert.equal(p.gross, 17700);
  assert.equal(p.bought, 7200); assert.equal(p.sold, 10500);
  assert.equal(p.puts.net, -1500); assert.equal(p.calls.net, -1800);
  assert.equal(p.B, -3300 / 17700); assert.equal(p.excluded.gamma, undefined);
  assert.equal(gammaFlowWidget.buildTimeSeries(history, {}).datasets[0].data[0], -3300);
  assert.doesNotMatch(gammaFlowWidget.buildTimeSeries(history, {}).chartOptions.gammaSummary, /USD delta-equivalent/);
  const compact = history.map((s) => trimSnapshotForWidgets(s, { widgets: [] }));
  assert.deepEqual(calculateGammaFlow(compact), calculateGammaFlow(history));
});

test('revalued gamma uses signed quantity and same-unit per-contract quotes without a spot multiplier', () => {
  const h = [snap(time, [tape('a', { gamma: -9000, size_contracts: 3, aggressor_buy_sell: 'BUY', underlying_price: 7760 })],
    [quote(100, { gamma: 2000, underlying_price: 8000 })])];
  assert.equal(last(h).net, -9000);
  const p = last(h, { gammaMode: 'revalued' });
  assert.equal(p.net, -6000); assert.equal(p.sold, 6000); assert.equal(p.bought, 0);
  h[0].tape.records[0].size_contracts = null;
  assert.equal(last(h).net, -9000); assert.equal(last(h, { gammaMode: 'revalued' }).net, null);
});
