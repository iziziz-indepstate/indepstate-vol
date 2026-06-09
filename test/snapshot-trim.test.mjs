import test from 'node:test';
import assert from 'node:assert/strict';
import { trimSnapshotForWidgets } from '../src/shared/snapshot-trim.mjs';
import { calculateAtmStraddle } from '../src/shared/atm-straddle-calculations.mjs';
import { calculateNDeltaIVPoint } from '../src/shared/n-delta-iv-calculations.mjs';
import { nDateSkewPutWidget } from '../src/renderer/widgets/ndate-put-skew-widget.js';

const time = '2026-06-08T14:30:00.000Z';

function quote(type, strike, overrides = {}) {
  const sign = type === 'put' ? -1 : 1;
  const distance = Math.abs(strike - 100);
  return {
    type,
    strike,
    bid: Math.max(0.5, 10 - distance * 0.1),
    ask: Math.max(0.75, 10.5 - distance * 0.1),
    mid: Math.max(0.625, 10.25 - distance * 0.1),
    iv: 0.2 + distance * 0.001,
    delta: type === 'put' ? -0.5 + distance * 0.01 * sign : 0.5 - distance * 0.01,
    gamma: 0.01,
    theta: -0.05,
    vega: 0.2,
    ...overrides
  };
}

function expirySnapshot(expiry) {
  const strikes = [80, 85, 90, 95, 100, 105, 110, 115, 120];
  const optionQuotes = strikes.flatMap((strike) => [
    quote('put', strike),
    quote('call', strike)
  ]);
  const bySide = (side, field) => Object.fromEntries(
    optionQuotes
      .filter((q) => q.type === side)
      .map((q) => [q.strike, q[field]])
  );
  const sideStrikes = (side) => optionQuotes
    .filter((q) => q.type === side)
    .map((q) => q.strike)
    .sort((a, b) => a - b);

  return {
    time,
    expiry,
    px: 100,
    lower: 100,
    upper: 105,
    atmPutIv: 0.2,
    atmCallIv: 0.205,
    putBidIvByStrike: bySide('put', 'iv'),
    putBidByStrike: bySide('put', 'bid'),
    putIvByStrike: bySide('put', 'iv'),
    putStrikesAsc: sideStrikes('put'),
    putStrikesDesc: sideStrikes('put').reverse(),
    callBidIvByStrike: bySide('call', 'iv'),
    callBidByStrike: bySide('call', 'bid'),
    callIvByStrike: bySide('call', 'iv'),
    callStrikesAsc: sideStrikes('call'),
    optionQuotes,
    atmIv: 0.2025
  };
}

function fullSnapshot() {
  const byExpiry = {
    20260612: expirySnapshot('20260612'),
    20260619: expirySnapshot('20260619'),
    20260626: expirySnapshot('20260626')
  };
  return {
    time,
    px: 100,
    expiry: '20260612',
    lower: 100,
    upper: 105,
    dAtm: 0.005,
    metrics: { dAtm: 0.005 },
    ...byExpiry['20260612'],
    byExpiry
  };
}

function strikesFor(trimmed, expiry, side) {
  return trimmed.byExpiry[expiry].optionQuotes
    .filter((q) => q.type === side)
    .map((q) => q.strike)
    .sort((a, b) => a - b);
}

test('nDate widget keeps only configured expiry range and selected strikes', () => {
  const trimmed = trimSnapshotForWidgets(fullSnapshot(), {
    widgets: [{
      type: 'ndate-skew-put-line',
      config: { baseStrike: 100, expiryStart: '20260612', expiryEnd: '20260612', strikeRange: 2 }
    }]
  });

  assert.deepEqual(Object.keys(trimmed.byExpiry), ['20260612']);
  assert.deepEqual(strikesFor(trimmed, '20260612', 'put'), [90, 95, 100]);
  assert.equal(strikesFor(trimmed, '20260612', 'call').length, 0);

  const series = nDateSkewPutWidget.buildSnapshotSeries(trimmed, {
    config: { baseStrike: 100, expiryStart: '20260612', expiryEnd: '20260612', strikeRange: 2 }
  });
  assert.deepEqual(series.labels, ['90', '95']);
  assert.equal(series.datasets[0].data.length, 2);
});

test('n-Delta IV keeps the requested expiration with full quote search surface', () => {
  const trimmed = trimSnapshotForWidgets(fullSnapshot(), {
    widgets: [{
      type: 'n-delta-iv',
      config: { expiration: '20260619', optionType: 'put', targetDelta: 0.25, baseStrike: 'ATM' }
    }]
  });

  assert.ok(trimmed.byExpiry['20260619']);
  assert.equal(trimmed.byExpiry['20260619'].optionQuotes.length, fullSnapshot().byExpiry['20260619'].optionQuotes.length);

  const point = calculateNDeltaIVPoint(trimmed, {
    expiration: '20260619',
    optionType: 'put',
    targetDelta: 0.25,
    baseStrike: 'ATM'
  });
  assert.equal(point.warning, null);
  assert.ok(Number.isFinite(point.deltaIV));
});

test('Straddle ATM remains calculable after trim', async () => {
  const trimmed = trimSnapshotForWidgets(fullSnapshot(), {
    widgets: [{
      type: 'atm-straddle',
      config: { expiryOverride: '2026-06-12', atmStrikeOverride: 100, tenor: '1W', compareTo: 'none' }
    }]
  });

  assert.deepEqual(strikesFor(trimmed, '20260612', 'put'), [100]);
  assert.deepEqual(strikesFor(trimmed, '20260612', 'call'), [100]);

  const result = await calculateAtmStraddle({
    snapshot: trimmed,
    snapshotTime: trimmed.time,
    expiryOverride: '2026-06-12',
    atmStrikeOverride: 100,
    compareTo: 'none'
  });
  assert.equal(result.atmStrike, 100);
  assert.ok(Number.isFinite(result.straddle.mid));
});

test('Spread Optimizer need keeps only configured strike range', () => {
  const trimmed = trimSnapshotForWidgets(fullSnapshot(), {
    widgets: [{
      type: 'spread-optimizer',
      config: { expiry: '20260612', strikeMin: 95, strikeMax: 105 }
    }]
  });

  assert.deepEqual(strikesFor(trimmed, '20260612', 'put'), [95, 100, 105]);
  assert.deepEqual(strikesFor(trimmed, '20260612', 'call'), [95, 100, 105]);
});

test('combined widgets merge requirements without losing shared fields', () => {
  const trimmed = trimSnapshotForWidgets(fullSnapshot(), {
    widgets: [
      { type: 'ndate-skew-put-line', config: { baseStrike: 100, expiryStart: '20260612', expiryEnd: '20260612', strikeRange: 2 } },
      { type: 'atm-straddle', config: { expiryOverride: '2026-06-12', atmStrikeOverride: 100, tenor: '1W' } }
    ]
  });

  assert.deepEqual(strikesFor(trimmed, '20260612', 'put'), [90, 95, 100]);
  assert.deepEqual(strikesFor(trimmed, '20260612', 'call'), [100]);
  assert.equal(trimmed.dAtm, 0.005);
  assert.equal(trimmed.storage.trimmed, true);
  assert.equal(trimmed.storage.trimVersion, 1);
});

test('trimming an already trimmed snapshot is idempotent', () => {
  const tab = {
    widgets: [{
      type: 'spread-optimizer',
      config: { expiry: '20260612', strikeMin: 95, strikeMax: 105 }
    }]
  };
  const once = trimSnapshotForWidgets(fullSnapshot(), tab);
  const twice = trimSnapshotForWidgets(once, tab);
  assert.deepEqual(twice, once);
});
