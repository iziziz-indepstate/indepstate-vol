import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOptionFlowTickSeries } from '../src/shared/option-flow-tick-calculations.mjs';

function snapshot(time, records, px = 100) {
  return {
    provider: 'tape-contract',
    time,
    px,
    tape: { count: records.length, records },
    contract: { count: 0, records: [] }
  };
}

function record(callPut, side, size, strike, extra = {}) {
  return {
    call_put: callPut,
    aggressor_buy_sell: side,
    size_contracts: size,
    strike,
    ...extra
  };
}

test('builds four cumulative option flow series from ATM strike window', () => {
  const result = buildOptionFlowTickSeries([
    snapshot('2026-10-12T10:00:00.000Z', [
      record('CALL', 'BUY', 10, 95),
      record('CALL', 'SELL', 3, 100),
      record('PUT', 'BUY', 5, 105),
      record('PUT', 'SELL', 7, 105)
    ]),
    snapshot('2026-10-12T10:01:00.000Z', [
      record('CALL', 'BUY', 2, 100),
      record('PUT', 'SELL', 4, 105)
    ])
  ], { strikeWindow: 1 });

  assert.equal(result.labels.length, 2);
  assert.deepEqual(result.datasets.map((dataset) => dataset.label), [
    'Bought calls',
    'Sold calls',
    'Bought puts',
    'Sold puts'
  ]);
  assert.deepEqual(result.datasets[0].data, [10, 12]);
  assert.deepEqual(result.datasets[1].data, [3, 3]);
  assert.deepEqual(result.datasets[2].data, [5, 5]);
  assert.deepEqual(result.datasets[3].data, [7, 11]);
});

test('filters by strike window and ignores invalid rows', () => {
  const result = buildOptionFlowTickSeries([
    snapshot('2026-10-12T10:00:00.000Z', [
      record('CALL', 'BUY', 10, 100),
      record('CALL', 'BUY', 10, 130),
      record('CALL', 'BUY', '', 100),
      record('CALL', 'HOLD', 10, 100),
      record('PUT', 'SELL', 4, 105)
    ])
  ], { strikeWindow: 1 });

  assert.deepEqual(result.datasets[0].data, [10]);
  assert.deepEqual(result.datasets[3].data, [4]);
  assert.equal(result.datasets[0].pointMeta[0].matchedRecords, 2);
});

test('falls back to tape underlying price when snapshot px is missing', () => {
  const result = buildOptionFlowTickSeries([
    snapshot('2026-10-12T10:00:00.000Z', [
      record('CALL', 'BUY', 10, 95, { underlying_price: '$100.00' }),
      record('CALL', 'BUY', 2, 115, { underlying_price: '$100.00' })
    ], null)
  ], { strikeWindow: 0 });

  assert.deepEqual(result.datasets[0].data, [10]);
  assert.equal(result.datasets[0].pointMeta[0].px, 100);
  assert.deepEqual(result.datasets[0].pointMeta[0].allowedStrikes, [95]);
});

test('parses formatted SPX tape prices for ATM selection', () => {
  const result = buildOptionFlowTickSeries([
    snapshot('2026-10-12T18:24:29.465Z', [
      record('PUT', 'BUY', 1, 7740, { underlying_price: '$7,799.8' }),
      record('PUT', 'SELL', 2, 7800, { underlying_price: '$7,799.8' })
    ], null)
  ], { strikeWindow: 0 });

  assert.equal(result.datasets[2].data[0], 0);
  assert.equal(result.datasets[3].data[0], 2);
  assert.equal(result.datasets[0].pointMeta[0].px, 7799.8);
  assert.deepEqual(result.datasets[0].pointMeta[0].allowedStrikes, [7800]);
});
