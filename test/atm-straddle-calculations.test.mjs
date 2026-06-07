import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateAtmStraddle,
  parseTenorToDte,
  selectAtmPair,
  selectExpiry,
  validateQuote
} from '../src/shared/atm-straddle-calculations.mjs';

const time = '2026-06-07T14:00:00.000Z';

function quote(type, strike, overrides = {}) {
  return {
    type,
    strike,
    bid: type === 'call' ? 50 : 45,
    ask: type === 'call' ? 52 : 47,
    iv: type === 'call' ? 0.21 : 0.22,
    delta: type === 'call' ? 0.51 : -0.49,
    gamma: 0.001,
    vega: 2,
    theta: -4,
    timestamp: time,
    ...overrides
  };
}

function expirySnap(px, optionQuotes) {
  return { time, px, optionQuotes, atmIv: 0.215 };
}

function snapshot(byExpiry, px = 6024.33) {
  return { time, px, byExpiry };
}

test('parses tenor strings to calendar DTE', () => {
  assert.equal(parseTenorToDte('1W'), 7);
  assert.equal(parseTenorToDte('2W'), 14);
  assert.equal(parseTenorToDte('1M'), 30);
  assert.equal(parseTenorToDte('0DTE'), 0);
  assert.throws(() => parseTenorToDte('bad'), /Invalid tenor/);
});

test('selects expiry by nearest, at_or_after, at_or_before, and exact override', () => {
  const snap = snapshot({
    20260609: expirySnap(100, [quote('call', 100), quote('put', 100)]),
    20260614: expirySnap(100, [quote('call', 100), quote('put', 100)]),
    20260621: expirySnap(100, [quote('call', 100), quote('put', 100)])
  });

  assert.equal(selectExpiry(snap, { tenor: '1W', snapshotTime: time }).key, '20260614');
  assert.equal(selectExpiry(snap, { tenor: '1W', snapshotTime: time, expirySelectionMode: 'at_or_after' }).key, '20260614');
  assert.equal(selectExpiry(snap, { tenor: '1W', snapshotTime: time, expirySelectionMode: 'at_or_before' }).key, '20260609');
  assert.equal(selectExpiry(snap, { expiryOverride: '2026-06-21', snapshotTime: time }).key, '20260621');
});

test('tenor expiry selection skips empty generated expiry dates', () => {
  const snap = snapshot({
    20260612: expirySnap(100, [quote('call', 100), quote('put', 100)]),
    20260613: expirySnap(100, []),
    20260614: expirySnap(100, [])
  });

  assert.equal(selectExpiry(snap, { tenor: '1W', snapshotTime: time }).key, '20260612');
  assert.equal(selectExpiry(snap, { expiryOverride: '2026-06-14', snapshotTime: time }).key, '20260614');
});

test('selects ATM strike nearest to spot and breaks ties by quote quality', () => {
  const snap = expirySnap(105, [
    quote('call', 100, { bid: 49, ask: 55 }),
    quote('put', 100, { bid: 44, ask: 50 }),
    quote('call', 110, { bid: 48, ask: 50 }),
    quote('put', 110, { bid: 43, ask: 45 })
  ]);

  const selected = selectAtmPair(snap, 105, time);
  assert.equal(selected.strike, 110);
  assert.equal(selected.atmSelectionMethod, 'nearest_to_reference');
});

test('falls back to delta-neutral ATM strike when reference is missing', () => {
  const snap = expirySnap(null, [
    quote('call', 100, { delta: 0.6 }),
    quote('put', 100, { delta: -0.3 }),
    quote('call', 110, { delta: 0.51 }),
    quote('put', 110, { delta: -0.50 })
  ]);

  const selected = selectAtmPair(snap, null, time);
  assert.equal(selected.strike, 110);
  assert.equal(selected.atmSelectionMethod, 'delta_neutral_fallback');
});

test('selects manual ATM strike override when provided', () => {
  const snap = expirySnap(105, [
    quote('call', 100),
    quote('put', 100),
    quote('call', 110),
    quote('put', 110)
  ]);

  const selected = selectAtmPair(snap, 105, time, 'mid', 100);
  assert.equal(selected.strike, 100);
  assert.equal(selected.atmSelectionMethod, 'manual_strike');
  assert.throws(() => selectAtmPair(snap, 105, time, 'mid', 105), /ATM strike 105/);
});

test('accepts explicit ATM strike override token', () => {
  const snap = expirySnap(107, [
    quote('call', 100),
    quote('put', 100),
    quote('call', 110),
    quote('put', 110)
  ]);

  const selected = selectAtmPair(snap, 107, time, 'mid', 'ATM');
  assert.equal(selected.strike, 110);
  assert.equal(selected.atmSelectionMethod, 'explicit_atm');
});

test('validates quote edge cases', () => {
  assert.deepEqual(validateQuote(quote('call', 100), time).flags, []);
  assert.ok(validateQuote(quote('call', 100, { bid: null, mark: 5 }), time, 'mark').flags.includes('MISSING_BID_ASK'));
  assert.ok(validateQuote(quote('call', 100, { bid: 10, ask: 9 }), time).flags.includes('NEGATIVE_OR_INVALID_QUOTE'));
  assert.ok(validateQuote(quote('call', 100, { timestamp: '2026-06-07T13:00:00.000Z' }), time).flags.includes('STALE_QUOTE'));
});

test('calculates straddle mid, bid/ask aggregation, implied move, and expected range', async () => {
  const snap = snapshot({
    20260614: expirySnap(6024.33, [
      quote('call', 6025, { bid: 57, ask: 59.4, iv: 0.215 }),
      quote('put', 6025, { bid: 53.8, ask: 55.6, iv: 0.221 })
    ])
  }, 6024.33);

  const result = await calculateAtmStraddle({ snapshot: snap, tenor: '1W', snapshotTime: time, compareTo: 'none' });
  assert.equal(result.atmStrike, 6025);
  assert.equal(result.call.mid, 58.2);
  assert.equal(result.put.mid, 54.7);
  assert.equal(result.straddle.bid, 110.8);
  assert.equal(result.straddle.ask, 115);
  assert.equal(result.straddle.mid, 112.9);
  assert.ok(Math.abs(result.straddle.impliedMovePct - (112.9 / 6024.33)) < 1e-12);
  assert.equal(result.straddle.expectedLow, 6024.33 - 112.9);
  assert.equal(result.straddle.expectedHigh, 6024.33 + 112.9);
  assert.equal(result.qualityFlags[0], 'OK');
});

test('uses manual reference price for ATM selection and implied move percent', async () => {
  const snap = snapshot({
    20260614: expirySnap(6024.33, [
      quote('call', 6020, { bid: 40, ask: 42 }),
      quote('put', 6020, { bid: 39, ask: 41 }),
      quote('call', 6050, { bid: 50, ask: 52 }),
      quote('put', 6050, { bid: 49, ask: 51 })
    ])
  }, 6024.33);

  const result = await calculateAtmStraddle({
    snapshot: snap,
    tenor: '1W',
    snapshotTime: time,
    compareTo: 'none',
    referencePriceMode: 'manual',
    manualReferencePrice: 6051
  });

  assert.equal(result.referencePrice, 6051);
  assert.equal(result.referencePriceSource, 'manual');
  assert.equal(result.atmStrike, 6050);
  assert.ok(Math.abs(result.straddle.impliedMovePct - (101 / 6051)) < 1e-12);
});

test('treats explicit Auto spot control value as datasource spot mode', async () => {
  const snap = snapshot({
    20260614: expirySnap(6024.33, [
      quote('call', 6025, { bid: 57, ask: 59 }),
      quote('put', 6025, { bid: 54, ask: 56 })
    ])
  }, 6024.33);

  const manualReferenceRaw = 'Auto';
  const manualReferenceToken = manualReferenceRaw.toUpperCase();
  const hasManualReferencePrice = manualReferenceRaw !== ''
    && manualReferenceToken !== 'AUTO'
    && manualReferenceToken !== 'ATM';
  const result = await calculateAtmStraddle({
    snapshot: snap,
    tenor: '1W',
    snapshotTime: time,
    compareTo: 'none',
    manualReferencePrice: hasManualReferencePrice ? manualReferenceRaw : undefined,
    referencePriceMode: hasManualReferencePrice ? 'manual' : 'spot'
  });

  assert.equal(result.referencePrice, 6024.33);
  assert.equal(result.referencePriceSource, 'spot');
  assert.equal(result.atmStrike, 6025);
});

test('calculates historical comparison and handles missing comparison data', async () => {
  const current = snapshot({
    20260614: expirySnap(6044, [
      quote('call', 6045, { bid: 40, ask: 42, iv: 0.19 }),
      quote('put', 6045, { bid: 38, ask: 40, iv: 0.20 })
    ])
  }, 6044);
  const previous = snapshot({
    20260614: expirySnap(6000, [
      quote('call', 6000, { bid: 50, ask: 52, iv: 0.22 }),
      quote('put', 6000, { bid: 49, ask: 51, iv: 0.23 })
    ])
  }, 6000);

  const result = await calculateAtmStraddle({ snapshot: current, comparisonSnapshot: previous, tenor: '1W', snapshotTime: time });
  assert.equal(result.comparison.deltaStraddlePts, 80 - 101);
  assert.ok(Math.abs(result.comparison.deltaStraddlePct - ((80 - 101) / 101)) < 1e-12);
  assert.ok(Math.abs(result.comparison.deltaAtmIv - (0.195 - 0.225)) < 1e-12);

  const missing = await calculateAtmStraddle({ snapshot: current, tenor: '1W', snapshotTime: time });
  assert.equal(missing.comparison, undefined);
  assert.ok(missing.stateLabels.includes('LOW_CONFIDENCE'));
});

test('assigns state labels for crush, bid, spot/vol combinations, and low confidence', async () => {
  const crush = await calculateAtmStraddle({
    snapshot: snapshot({ 20260614: expirySnap(6040, [quote('call', 6040, { bid: 40, ask: 42, iv: 0.18 }), quote('put', 6040, { bid: 38, ask: 40, iv: 0.18 })]) }, 6040),
    comparisonSnapshot: snapshot({ 20260614: expirySnap(6000, [quote('call', 6000, { bid: 50, ask: 52, iv: 0.22 }), quote('put', 6000, { bid: 49, ask: 51, iv: 0.22 })]) }, 6000),
    tenor: '1W',
    snapshotTime: time
  });
  assert.ok(crush.stateLabels.includes('VOL_CRUSH'));
  assert.ok(crush.stateLabels.includes('SPOT_UP_VOL_UP') === false);

  const bid = await calculateAtmStraddle({
    snapshot: snapshot({ 20260614: expirySnap(6020, [quote('call', 6020, { bid: 60, ask: 62, iv: 0.24 }), quote('put', 6020, { bid: 59, ask: 61, iv: 0.24 })]) }, 6020),
    comparisonSnapshot: snapshot({ 20260614: expirySnap(6000, [quote('call', 6000, { bid: 50, ask: 52, iv: 0.22 }), quote('put', 6000, { bid: 49, ask: 51, iv: 0.22 })]) }, 6000),
    tenor: '1W',
    snapshotTime: time
  });
  assert.ok(bid.stateLabels.includes('MOVEMENT_BID'));
  assert.ok(bid.stateLabels.includes('SPOT_UP_VOL_UP'));

  const downVolDown = await calculateAtmStraddle({
    snapshot: snapshot({ 20260614: expirySnap(5980, [quote('call', 5980, { bid: 45, ask: 47, iv: 0.20 }), quote('put', 5980, { bid: 44, ask: 46, iv: 0.20 })]) }, 5980),
    comparisonSnapshot: snapshot({ 20260614: expirySnap(6000, [quote('call', 6000, { bid: 50, ask: 52, iv: 0.22 }), quote('put', 6000, { bid: 49, ask: 51, iv: 0.22 })]) }, 6000),
    tenor: '1W',
    snapshotTime: time
  });
  assert.ok(downVolDown.stateLabels.includes('SPOT_DOWN_VOL_DOWN'));
});
