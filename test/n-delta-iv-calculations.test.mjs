import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildNDeltaIVSeries,
  calculateAtmIV,
  calculateNDeltaIVPoint,
  normalizeExpiryKey,
  selectNearestDeltaQuote
} from '../src/shared/n-delta-iv-calculations.mjs';

const time = '2026-06-07T14:00:00.000Z';

function quote(type, strike, delta, iv, overrides = {}) {
  return {
    type,
    strike,
    delta,
    iv,
    bid: 1,
    ask: 2,
    ...overrides
  };
}

function expirySnap(px, optionQuotes) {
  return { time, px, optionQuotes };
}

test('normalizes date-like expiration keys', () => {
  assert.equal(normalizeExpiryKey('2026-06-12'), '20260612');
  assert.equal(normalizeExpiryKey('20260612'), '20260612');
});

test('selects nearest put and call contracts by target absolute delta', () => {
  const snap = expirySnap(100, [
    quote('put', 90, -0.19, 0.31),
    quote('put', 95, -0.26, 0.29),
    quote('call', 105, 0.24, 0.22),
    quote('call', 110, 0.12, 0.25)
  ]);

  assert.equal(selectNearestDeltaQuote(snap, 'put', 0.25).strike, 95);
  assert.equal(selectNearestDeltaQuote(snap, 'call', 0.10).strike, 110);
});

test('filters invalid quotes before delta matching', () => {
  const snap = expirySnap(100, [
    quote('put', 90, -0.25, 0.31, { ask: 0 }),
    quote('put', 95, -0.22, 0.29)
  ]);

  assert.equal(selectNearestDeltaQuote(snap, 'put', 0.25).strike, 95);
});

test('calculates ATM IV from strike nearest underlying reference price', () => {
  const snap = expirySnap(103, [
    quote('call', 100, 0.60, 0.21),
    quote('put', 100, -0.40, 0.23),
    quote('call', 105, 0.48, 0.24),
    quote('put', 105, -0.52, 0.26)
  ]);

  assert.deepEqual(calculateAtmIV(snap), { atmStrike: 105, atmIV: 0.25 });
});

test('falls back to 50-delta ATM selection when reference price is unavailable', () => {
  const snap = expirySnap(null, [
    quote('call', 100, 0.65, 0.21),
    quote('put', 100, -0.35, 0.23),
    quote('call', 105, 0.49, 0.24),
    quote('put', 105, -0.51, 0.26)
  ]);

  assert.deepEqual(calculateAtmIV(snap), { atmStrike: 105, atmIV: 0.25 });
});

test('builds n-delta point with delta IV, ATM IV, and premium', () => {
  const snapshot = {
    time,
    byExpiry: {
      20260612: expirySnap(100, [
        quote('put', 90, -0.25, 0.30),
        quote('call', 100, 0.50, 0.20),
        quote('put', 100, -0.50, 0.22)
      ])
    }
  };

  const point = calculateNDeltaIVPoint(snapshot, {
    optionType: 'put',
    targetDelta: 0.25,
    expiration: '2026-06-12'
  });

  assert.equal(point.matchedStrike, 90);
  assert.equal(point.matchedDelta, -0.25);
  assert.equal(point.deltaIV, 0.30);
  assert.equal(point.atmStrike, 100);
  assert.ok(Math.abs(point.atmIV - 0.21) < 1e-12);
  assert.ok(Math.abs(point.deltaIVPremium - 0.09) < 1e-12);
});

test('defaults to primary snapshot expiration when config expiration is empty', () => {
  const snapshot = {
    time,
    expiry: '20260612',
    byExpiry: {
      20260612: expirySnap(100, [
        quote('call', 105, 0.24, 0.28),
        quote('call', 100, 0.50, 0.20),
        quote('put', 100, -0.50, 0.22)
      ])
    }
  };

  const point = calculateNDeltaIVPoint(snapshot, {
    optionType: 'call',
    targetDelta: 0.25,
    expiration: ''
  });

  assert.equal(point.expiration, '20260612');
  assert.equal(point.matchedStrike, 105);
  assert.equal(point.deltaIV, 0.28);
});

test('returns null values instead of throwing when expiration is missing', () => {
  const [point] = buildNDeltaIVSeries([{ time, byExpiry: {} }], {
    optionType: 'call',
    targetDelta: 0.05,
    expiration: '2026-06-12'
  });

  assert.equal(point.deltaIV, null);
  assert.equal(point.atmIV, null);
  assert.equal(point.warning, 'no expiration match');
});
