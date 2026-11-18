import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateRealizedCorrelationSeries as calculate, resolveEwmaConfig } from '../src/shared/realized-correlation-calculations.mjs';

function fixture(sign = 1, calendarDays = 55) {
  const dates = Array.from({ length: calendarDays }, (_, i) => new Date(Date.UTC(2026, 0, i + 1)))
    .filter((date) => ![0, 6].includes(date.getUTCDay())).map((date) => date.toISOString().slice(0, 10));
  const changes = dates.map((_, i) => Math.sin(i * 1.7) * 0.02);
  const build = (factor) => { let close = 100; return dates.map((date, i) => ({ date, close: close *= Math.exp(changes[i] * factor) })); };
  return { basket: [{ symbol: 'A', weight: 3 }, { symbol: 'B', weight: 7 }],
    calendarRows: dates.map((date) => ({ date, close: 100 })), prices: { A: build(1), B: build(sign) },
    cor1mRows: dates.map((date) => ({ date, close: 25 })) };
}

test('identical and opposite returns yield +100 and -100 at all three horizons', () => {
  for (const sign of [1, -1]) {
    const result = calculate(fixture(sign));
    for (const key of ['rc5', 'rc10', 'rc21', 'rcEwma']) assert.ok(Math.abs(result.latest[key] - sign * 100) < 1e-8);
    assert.equal(result.series[3].rc5, null);
    assert.ok(result.series[4].rc5 !== null);
    assert.equal(result.series[19].rc21, null);
    assert.ok(result.series[20].rc21 !== null);
  }
});

test('EWMA agrees with an independent weighted covariance matrix and decays by half every H sessions', () => {
  const input = fixture(1, 240);
  let close = 100;
  input.prices.B = input.calendarRows.map(({ date }, i) => ({ date, close: close *= Math.exp(Math.cos(i * 0.7) * 0.025) }));
  const halfLife = 7;
  const result = calculate({ ...input, ewmaHalfLife: halfLife });
  const count = 10 * halfLife;
  const timeWeights = Array.from({ length: count }, (_, age) => 2 ** (-age / halfLife));
  assert.ok(Math.abs(timeWeights[7] / timeWeights[0] - 0.5) < 1e-12);
  const total = timeWeights.reduce((sum, value) => sum + value, 0);
  const returns = input.basket.map(({ symbol }) => {
    const closes = input.prices[symbol].slice(-count - 1);
    return closes.slice(1).map((row, i) => Math.log(row.close / closes[i].close)).reverse();
  });
  const means = returns.map((row) => row.reduce((sum, value, age) => sum + value * timeWeights[age], 0) / total);
  const cov = (i, j) => returns[i].reduce((sum, value, age) => sum + timeWeights[age] * (value - means[i]) * (returns[j][age] - means[j]), 0) / total;
  const expected = 100 * cov(0, 1) / Math.sqrt(cov(0, 0) * cov(1, 1));
  assert.ok(Math.abs(result.latest.rcEwma - expected) < 1e-9);
  assert.ok(Math.abs(result.latest.rcEwma - result.latest.rc21) > 0.1);
  assert.deepEqual(result.ewma, resolveEwmaConfig(7));
});

test('EWMA is invariant to display start with full warmup and ignores future observations', () => {
  const input = fixture(1, 330);
  const result = calculate(input);
  const startDate = input.calendarRows[150].date;
  const prefix = { ...input, calendarRows: input.calendarRows.slice(50), startDate };
  assert.deepEqual(calculate(prefix).series, result.series.filter((row) => row.date >= startDate));
  const endDate = input.calendarRows[180].date;
  const truncated = calculate({ ...prefix, endDate });
  input.prices.A.at(-1).close *= 20;
  assert.deepEqual(calculate({ ...prefix, endDate }).series, truncated.series);
  assert.equal(truncated.ewma.lookbackSessions, 100);
});

test('EWMA needs 21 complete returns, resets on gaps and treats zero risk as unavailable', () => {
  const input = fixture();
  const full = calculate(input);
  assert.equal(full.series[19].rcEwma, null);
  assert.ok(full.series[20].rcEwma !== null);
  input.prices.B.splice(9, 1);
  const result = calculate(input);
  assert.equal(result.series[29].rcEwma, null);
  assert.ok(result.series[30].rcEwma !== null);
  assert.ok(result.warnings.some((warning) => /EWMA/.test(warning)));
  // Retain an early valid RC window, then fill an entire EWMA lookback with flat prices.
  const flat = fixture(1, 240);
  for (const rows of Object.values(flat.prices)) for (let i = 22; i < rows.length; i += 1) rows[i].close = rows[21].close;
  assert.equal(calculate(flat).latest.rcEwma, null);
  assert.equal(resolveEwmaConfig(1).lookbackSessions, 21);
  assert.equal(resolveEwmaConfig(63).lookbackSessions, 630);
  for (const value of [0, 64, 1.2, '', null, 'NaN']) assert.throws(() => resolveEwmaConfig(value), /half-life/);
});

test('agrees with independently computed weighted pairwise covariance and is invariant to weight scale', () => {
  const input = fixture();
  input.basket.push({ symbol: 'C', weight: 2 });
  let price = 70;
  input.prices.C = input.calendarRows.map(({ date }, i) => ({ date, close: price *= Math.exp(Math.cos(i * 0.9) * 0.03) }));
  const returns = input.basket.map(({ symbol }) => input.prices[symbol].slice(-22)
    .slice(1).map((row, i) => Math.log(row.close / input.prices[symbol].slice(-22)[i].close)));
  const means = returns.map((row) => row.reduce((sum, value) => sum + value, 0) / 21);
  const cov = (i, j) => returns[i].reduce((sum, value, k) => sum + (value - means[i]) * (returns[j][k] - means[j]), 0) / 20;
  let numerator = 0; let denominator = 0;
  for (let i = 0; i < 3; i += 1) for (let j = i + 1; j < 3; j += 1) {
    const w = input.basket[i].weight * input.basket[j].weight;
    numerator += w * cov(i, j);
    denominator += w * Math.sqrt(cov(i, i) * cov(j, j));
  }
  const result = calculate(input);
  assert.ok(Math.abs(result.latest.rc21 - 100 * numerator / denominator) < 1e-9);
  input.basket.forEach((row) => { row.weight *= 100; });
  assert.deepEqual(calculate(input).series, result.series);
});

test('missing prices break windows without shrinking the basket or bridging sessions', () => {
  const input = fixture();
  const missing = input.prices.B[9].date;
  input.prices.B.splice(9, 1);
  const result = calculate(input);
  assert.equal(result.series.find((row) => row.date === missing).rc5, null);
  assert.equal(result.series[13].rc5, null);
  assert.ok(result.series[14].rc5 !== null);
  assert.equal(result.series[28].rc21, null);
  assert.ok(result.series[30].rc21 !== null);
});

test('aligns COR1M by exact date, accepts negative values, and never uses future prices', () => {
  const input = fixture();
  input.cor1mRows = [input.cor1mRows[21], { ...input.cor1mRows[22], close: -1 }];
  const result = calculate(input);
  assert.equal(result.latest.cor1m, null);
  assert.equal(result.latest.spread, null);
  assert.equal(result.series[21].cor1m, -1);
  const endDate = input.calendarRows[26].date;
  const prefix = calculate({ ...input, endDate });
  input.prices.A[30].close *= 100;
  assert.deepEqual(calculate({ ...input, endDate }).series, prefix.series);
  assert.deepEqual(prefix.series, result.series.filter((row) => row.date <= endDate));
});

test('zero variance returns null while invalid weights and insufficient history report errors', () => {
  const input = fixture();
  for (let i = 22; i < input.prices.A.length; i += 1) {
    input.prices.A[i].close = input.prices.A[21].close;
    input.prices.B[i].close = input.prices.B[21].close;
  }
  assert.equal(calculate(input).latest.rc5, null);
  assert.throws(() => calculate({ ...input, basket: [{ symbol: 'A', weight: -1 }, { symbol: 'B', weight: 2 }] }), /weights/);
  assert.throws(() => calculate({ ...input, calendarRows: input.calendarRows.slice(0, 5) }), /Not enough/);
});
