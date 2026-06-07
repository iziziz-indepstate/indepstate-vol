import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateForwardVols } from '../src/shared/forward-vol-calculations.mjs';

test('calculates forward volatility between adjacent straddles sorted by DTE', () => {
  const result = calculateForwardVols([
    { label: '1M', dte: 29.6, iv: 0.170 },
    { label: '1D', dte: 1.6, iv: 0.204 },
    { label: '1W', dte: 5.6, iv: 0.221 }
  ]);

  assert.equal(result.length, 2);
  assert.equal(result[0].fromLabel, '1D');
  assert.equal(result[0].toLabel, '1W');
  const expectedFirst = Math.sqrt(((0.221 ** 2) * 5.6 - (0.204 ** 2) * 1.6) / (5.6 - 1.6));
  assert.ok(Math.abs(result[0].forwardVol - expectedFirst) < 1e-12);
  assert.equal(result[0].status, 'ok');
  assert.equal(result[1].fromLabel, '1W');
  assert.equal(result[1].toLabel, '1M');
  const expectedSecond = Math.sqrt(((0.170 ** 2) * 29.6 - (0.221 ** 2) * 5.6) / (29.6 - 5.6));
  assert.ok(Math.abs(result[1].forwardVol - expectedSecond) < 1e-12);
});

test('marks negative forward variance invalid without square root', () => {
  const result = calculateForwardVols([
    { label: 'near', dte: 1, iv: 0.5 },
    { label: 'far', dte: 2, iv: 0.1 }
  ]);

  assert.equal(result[0].status, 'invalid_negative_forward_variance');
  assert.ok(result[0].forwardVariance < 0);
  assert.ok(Number.isNaN(result[0].forwardVol));
  assert.ok(Number.isNaN(result[0].forwardVolPercent));
});

test('filters incomplete points before segment calculation', () => {
  const result = calculateForwardVols([
    { label: 'bad', dte: null, iv: 0.2 },
    { label: '1D', dte: 1, iv: 0.2 },
    { label: '1W', dte: 7, iv: 0.25 }
  ]);

  assert.equal(result.length, 1);
  assert.equal(result[0].fromLabel, '1D');
  assert.equal(result[0].toLabel, '1W');
});
