import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOptionFlowBalancedTickSeries,
  buildOptionFlowTickSeries
} from '../src/shared/option-flow-tick-calculations.mjs';
import {
  optionFlowBalancedTickWidget,
  optionFlowTickWidget
} from '../src/renderer/widgets/option-flow-tick-widget.js';

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

test('builds cumulative balanced option flow series', () => {
  const result = buildOptionFlowBalancedTickSeries([
    snapshot('2026-10-12T10:00:00.000Z', [
      record('CALL', 'BUY', 10, 100),
      record('CALL', 'SELL', 3, 100),
      record('PUT', 'BUY', 5, 105),
      record('PUT', 'SELL', 8, 105)
    ]),
    snapshot('2026-10-12T10:01:00.000Z', [
      record('CALL', 'BUY', 2, 100),
      record('CALL', 'SELL', 6, 100),
      record('PUT', 'BUY', 9, 105),
      record('PUT', 'SELL', 1, 105)
    ])
  ], { strikeWindow: 1 });

  assert.deepEqual(result.datasets.map((dataset) => dataset.label), [
    'Calls balance',
    'Puts balance',
    'Directional balance',
    'Imbalance'
  ]);
  assert.deepEqual(result.datasets[0].data, [7, 3]);
  assert.deepEqual(result.datasets[1].data, [-3, 5]);
  assert.deepEqual(result.datasets[2].data, [10, -2]);
  assert.deepEqual(result.datasets[3].data, [10 / 26, -2 / 44]);
  assert.deepEqual(result.datasets[0].pointMeta[1].balances, {
    callsBalance: 3,
    putsBalance: 5,
    directionalBalance: -2,
    imbalance: -2 / 44
  });
});

test('balanced option flow uses the ATM strike window and ignores invalid rows', () => {
  const result = buildOptionFlowBalancedTickSeries([
    snapshot('2026-10-12T10:00:00.000Z', [
      record('CALL', 'BUY', 10, 100),
      record('CALL', 'SELL', 3, 100),
      record('CALL', 'BUY', 10, 130),
      record('CALL', 'BUY', '', 100),
      record('CALL', 'HOLD', 10, 100),
      record('PUT', 'SELL', 4, 105)
    ])
  ], { strikeWindow: 1 });

  assert.deepEqual(result.datasets[0].data, [7]);
  assert.deepEqual(result.datasets[1].data, [-4]);
  assert.deepEqual(result.datasets[2].data, [11]);
  assert.deepEqual(result.datasets[3].data, [11 / 17]);
  assert.equal(result.datasets[0].pointMeta[0].matchedRecords, 3);
});

test('balanced option flow parses formatted SPX tape prices for ATM selection', () => {
  const result = buildOptionFlowBalancedTickSeries([
    snapshot('2026-10-12T18:24:29.465Z', [
      record('PUT', 'BUY', 1, 7740, { underlying_price: '$7,799.8' }),
      record('PUT', 'SELL', 2, 7800, { underlying_price: '$7,799.8' }),
      record('CALL', 'BUY', 4, 7800, { underlying_price: '$7,799.8' })
    ], null)
  ], { strikeWindow: 0 });

  assert.deepEqual(result.datasets[0].data, [4]);
  assert.deepEqual(result.datasets[1].data, [-2]);
  assert.deepEqual(result.datasets[2].data, [6]);
  assert.deepEqual(result.datasets[3].data, [1]);
  assert.equal(result.datasets[0].pointMeta[0].px, 7799.8);
  assert.deepEqual(result.datasets[0].pointMeta[0].allowedStrikes, [7800]);
});

test('option flow tick MA modes use trailing timestamp window sums', () => {
  const history = [
    snapshot('2026-10-12T10:00:00.000Z', [
      record('CALL', 'BUY', 10, 100)
    ]),
    snapshot('2026-10-12T10:01:00.000Z', [
      record('CALL', 'SELL', 3, 100),
      record('PUT', 'BUY', 5, 105)
    ]),
    snapshot('2026-10-12T10:04:01.000Z', [
      record('CALL', 'BUY', 2, 100),
      record('PUT', 'SELL', 7, 105)
    ])
  ];

  const byMode = {
    'ma-1m': [2, 0, 0, 7],
    'ma-3m': [2, 0, 0, 7],
    'ma-5m': [12, 3, 5, 7],
    'ma-15m': [12, 3, 5, 7]
  };

  for (const [flowDisplayMode, expectedLastValues] of Object.entries(byMode)) {
    const result = buildOptionFlowTickSeries(history, { strikeWindow: 1, flowDisplayMode });
    assert.deepEqual(result.datasets.map((dataset) => dataset.data.at(-1)), expectedLastValues);
    assert.equal(result.datasets[0].pointMeta.at(-1).displayMode, flowDisplayMode);
    assert.equal(result.datasets[0].pointMeta.at(-1).flowWindowMinutes, Number(flowDisplayMode.match(/\d+/)[0]));
  }
});

test('balanced option flow MA modes derive balances from trailing timestamp window sums', () => {
  const history = [
    snapshot('2026-10-12T10:00:00.000Z', [
      record('CALL', 'BUY', 10, 100),
      record('PUT', 'SELL', 1, 105)
    ]),
    snapshot('2026-10-12T10:01:00.000Z', [
      record('CALL', 'SELL', 3, 100),
      record('PUT', 'BUY', 5, 105)
    ]),
    snapshot('2026-10-12T10:04:01.000Z', [
      record('CALL', 'BUY', 2, 100),
      record('PUT', 'SELL', 7, 105)
    ])
  ];

  const shortWindow = buildOptionFlowBalancedTickSeries(history, { strikeWindow: 1, flowDisplayMode: 'ma-3m' });
  assert.deepEqual(shortWindow.datasets.map((dataset) => dataset.data.at(-1)), [
    2,
    -7,
    9,
    1
  ]);
  assert.deepEqual(shortWindow.datasets[0].pointMeta.at(-1).displayBalances, {
    callsBalance: 2,
    putsBalance: -7,
    directionalBalance: 9,
    imbalance: 1
  });

  const longWindow = buildOptionFlowBalancedTickSeries(history, { strikeWindow: 1, flowDisplayMode: 'ma-5m' });
  assert.deepEqual(longWindow.datasets.map((dataset) => dataset.data.at(-1)), [
    9,
    -3,
    12,
    12 / 28
  ]);
});

test('balanced option flow MA imbalance returns zero when trailing window gross is zero', () => {
  const result = buildOptionFlowBalancedTickSeries([
    snapshot('2026-10-12T10:00:00.000Z', [
      record('CALL', 'HOLD', 10, 100),
      record('PUT', 'SELL', 5, 130)
    ])
  ], { strikeWindow: 0, flowDisplayMode: 'ma-1m' });

  assert.deepEqual(result.datasets.map((dataset) => dataset.data[0]), [0, 0, 0, 0]);
  assert.equal(result.datasets[0].pointMeta[0].displayBalances.imbalance, 0);
});

test('option flow widget display offset trims rendered points without changing cumulative calculation', () => {
  const result = optionFlowTickWidget.buildTimeSeries([
    snapshot('2026-10-12T10:00:00.000Z', [
      record('CALL', 'BUY', 10, 100)
    ]),
    snapshot('2026-10-12T10:01:00.000Z', [
      record('CALL', 'BUY', 2, 100),
      record('PUT', 'SELL', 4, 105)
    ])
  ], {
    config: {
      strikeWindow: 1,
      displayPointOffset: 1,
      displayPointLimit: ''
    }
  });

  assert.equal(result.labels.length, 1);
  assert.deepEqual(result.datasets[0].data, [12]);
  assert.deepEqual(result.datasets[3].data, [4]);
  assert.deepEqual(result.datasets[0].pointMeta[0].totals, {
    boughtCalls: 12,
    soldCalls: 0,
    boughtPuts: 0,
    soldPuts: 4
  });
});

test('balanced option flow widget display limit trims rendered points without changing MA calculation', () => {
  const result = optionFlowBalancedTickWidget.buildTimeSeries([
    snapshot('2026-10-12T10:00:00.000Z', [
      record('CALL', 'BUY', 10, 100)
    ]),
    snapshot('2026-10-12T10:01:00.000Z', [
      record('CALL', 'SELL', 3, 100),
      record('PUT', 'BUY', 5, 105)
    ]),
    snapshot('2026-10-12T10:04:01.000Z', [
      record('CALL', 'BUY', 2, 100),
      record('PUT', 'SELL', 7, 105)
    ])
  ], {
    config: {
      strikeWindow: 1,
      flowDisplayMode: 'ma-5m',
      displayPointOffset: 1,
      displayPointLimit: 1
    }
  });

  assert.equal(result.labels.length, 1);
  assert.deepEqual(result.datasets.map((dataset) => dataset.data[0]), [
    9,
    -2,
    11,
    11 / 27
  ]);
  assert.equal(result.datasets[0].pointMeta[0].flowWindowMinutes, 5);
});
