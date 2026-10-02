import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIVDynamicsMatrix,
  buildIVDynamicsRows,
  normalizeIVDynamicsCompareMode,
  parseIVDynamicsDeltas
} from '../src/shared/iv-dynamics-calculations.mjs';

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

function snapshot(time, overrides = {}) {
  const atmPutIv = overrides.atmPutIv ?? 0.20;
  const atmCallIv = overrides.atmCallIv ?? 0.22;
  const skew = overrides.skew ?? 0;
  const byExpiry = {
    20260612: {
      time,
      px: 100,
      optionQuotes: [
        quote('put', 60, -0.05, 0.40 + skew),
        quote('put', 70, -0.10, 0.35 + skew),
        quote('put', 80, -0.25, 0.30 + skew),
        quote('put', 90, -0.50, 0.25 + skew),
        quote('put', 95, -0.75, 0.23 + skew),
        quote('put', 98, -0.90, 0.21 + skew),
        quote('put', 100, -0.50, atmPutIv + skew),
        quote('call', 100, 0.50, atmCallIv + skew),
        quote('call', 102, 0.90, 0.23 + skew),
        quote('call', 105, 0.75, 0.24 + skew),
        quote('call', 110, 0.50, 0.26 + skew),
        quote('call', 120, 0.25, 0.31 + skew),
        quote('call', 130, 0.10, 0.36 + skew),
        quote('call', 140, 0.05, 0.41 + skew)
      ]
    }
  };
  return {
    time,
    px: 100,
    expiry: '20260612',
    byExpiry,
    ...overrides.root
  };
}

test('parses default deltas and builds row order around two ATM rows', () => {
  assert.deepEqual(parseIVDynamicsDeltas(), {
    includeAtm: true,
    deltas: [0.05, 0.1, 0.25, 0.5, 0.75, 0.9]
  });
  assert.deepEqual(buildIVDynamicsRows().map((row) => row.label), [
    'C 5D',
    'C 10D',
    'C 25D',
    'C 50D',
    'C 75D',
    'C 90D',
    'C ATM',
    'P ATM',
    'P 90D',
    'P 75D',
    'P 50D',
    'P 25D',
    'P 10D',
    'P 5D'
  ]);
});

test('selects nearest put and call delta quotes and uses shared ATM baseline', () => {
  const matrix = buildIVDynamicsMatrix([snapshot('2026-06-07T14:00:00.000Z')], {
    expiration: '20260612',
    deltas: 'ATM,90,75,50,25,10,5',
    mode: 'premium'
  });
  const byLabel = Object.fromEntries(matrix.rows.map((row, idx) => [row.label, matrix.cells[idx][0]]));

  assert.equal(byLabel['P 90D'].matchedStrike, 98);
  assert.equal(byLabel['P 5D'].matchedStrike, 60);
  assert.equal(byLabel['C 90D'].matchedStrike, 102);
  assert.equal(byLabel['C 5D'].matchedStrike, 140);
  assert.equal(byLabel['P ATM'].matchedStrike, 100);
  assert.equal(byLabel['C ATM'].matchedStrike, 100);
  assert.ok(Math.abs(byLabel['P ATM'].atmIV - 0.21) < 1e-12);
  assert.ok(Math.abs(byLabel['P ATM'].premium - -0.01) < 1e-12);
  assert.ok(Math.abs(byLabel['C ATM'].premium - 0.01) < 1e-12);
});

test('supports premium and absolute IV display modes', () => {
  const history = [snapshot('2026-06-07T14:00:00.000Z')];
  const premium = buildIVDynamicsMatrix(history, { mode: 'premium', deltas: '25' });
  const iv = buildIVDynamicsMatrix(history, { mode: 'iv', deltas: '25' });
  const premiumByLabel = Object.fromEntries(premium.rows.map((row, idx) => [row.label, premium.cells[idx][0]]));
  const ivByLabel = Object.fromEntries(iv.rows.map((row, idx) => [row.label, iv.cells[idx][0]]));

  assert.equal(premium.mode, 'premium');
  assert.ok(Math.abs(premiumByLabel['P 25D'].value - 0.09) < 1e-12);
  assert.equal(iv.mode, 'iv');
  assert.equal(ivByLabel['P 25D'].value, 0.30);
});

test('normalizes IV Dynamics compare mode', () => {
  assert.equal(normalizeIVDynamicsCompareMode('session'), 'session');
  assert.equal(normalizeIVDynamicsCompareMode('previous'), 'previous');
  assert.equal(normalizeIVDynamicsCompareMode('bad'), 'previous');
  assert.equal(buildIVDynamicsMatrix([snapshot('2026-06-07T14:00:00.000Z')], {}).compareMode, 'previous');
  assert.equal(buildIVDynamicsMatrix([snapshot('2026-06-07T14:00:00.000Z')], { compareMode: 'session' }).compareMode, 'session');
});

test('calculates previous, 15 minute, 60 minute, and session changes', () => {
  const history = [
    snapshot('2026-06-07T14:00:00.000Z', { skew: 0 }),
    snapshot('2026-06-07T14:10:00.000Z', { skew: 0.01 }),
    snapshot('2026-06-07T14:45:00.000Z', { skew: 0.02 }),
    snapshot('2026-06-07T15:05:00.000Z', { skew: 0.03 })
  ];
  const matrix = buildIVDynamicsMatrix(history, { mode: 'iv', deltas: '25' });
  const last = matrix.cells[0][3];

  assert.ok(Math.abs(last.comparisons.previous - 0.01) < 1e-12);
  assert.ok(Math.abs(last.comparisons.m15 - 0.01) < 1e-12);
  assert.ok(Math.abs(last.comparisons.m60 - 0.03) < 1e-12);
  assert.ok(Math.abs(last.comparisons.session - 0.03) < 1e-12);
});

test('returns null cells and warnings when expiration is missing', () => {
  const matrix = buildIVDynamicsMatrix([snapshot('2026-06-07T14:00:00.000Z')], {
    expiration: '20260619',
    deltas: 'ATM,25'
  });

  assert.equal(matrix.cells[0][0].iv, null);
  assert.ok(matrix.warnings.some((warning) => warning.includes('missing expiration')));
});

test('builds BA series from root snapshot px aligned to columns', () => {
  const matrix = buildIVDynamicsMatrix([
    snapshot('2026-06-07T14:00:00.000Z', { root: { px: 100 } }),
    snapshot('2026-06-07T14:01:00.000Z', { root: { px: 105 } }),
    snapshot('2026-06-07T14:02:00.000Z', { root: { px: 103 } })
  ], {
    deltas: '25',
    showBA: true
  });

  assert.equal(matrix.showBA, true);
  assert.deepEqual(matrix.columns.map((column) => column.baPrice), [100, 105, 103]);
  assert.deepEqual(matrix.baSeries.map((point) => point.price), [100, 105, 103]);
  assert.equal(matrix.baSeries.length, matrix.columns.length);
  assert.equal(matrix.cells[0][1].baPrice, 105);
  assert.equal(matrix.baSeries[0].y, 0);
  assert.equal(matrix.baSeries[1].y, 1);
});

test('BA series handles missing and flat px values safely', () => {
  const missing = buildIVDynamicsMatrix([
    snapshot('2026-06-07T14:00:00.000Z', { root: { px: null } }),
    snapshot('2026-06-07T14:01:00.000Z', { root: { px: 101 } })
  ], { deltas: '25' });
  assert.equal(missing.baSeries[0].price, null);
  assert.equal(missing.baSeries[0].y, null);
  assert.equal(missing.baSeries[1].y, 0.5);

  const flat = buildIVDynamicsMatrix([
    snapshot('2026-06-07T14:00:00.000Z', { root: { px: 100 } }),
    snapshot('2026-06-07T14:01:00.000Z', { root: { px: 100 } })
  ], { deltas: '25' });
  assert.deepEqual(flat.baSeries.map((point) => point.y), [0.5, 0.5]);
});
