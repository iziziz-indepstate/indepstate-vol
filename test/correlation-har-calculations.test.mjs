import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { HAR_MODEL, fitHarOls, buildHarSamples, calculateHarForecast, matureHarForecast } from '../src/shared/correlation-har-calculations.mjs';
import { calculateRealizedCorrelationSeries } from '../src/shared/realized-correlation-calculations.mjs';

function inputs(count = 750) {
  let seed = 42;
  const random = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 2 ** 32 - 0.5; };
  const dates = [];
  for (let i = 0; dates.length < count; i += 1) {
    const date = new Date(Date.UTC(2022, 0, 3 + i));
    if (![0, 6].includes(date.getUTCDay())) dates.push(date.toISOString().slice(0, 10));
  }
  let a = 100, b = 100;
  const prices = { A: [], B: [] };
  dates.forEach((date, i) => {
    const common = random() * (0.5 + 0.4 * Math.sin(i / 40));
    a *= Math.exp((common + random() * 0.8) * 0.03);
    b *= Math.exp((common + random() * 0.8) * 0.03);
    prices.A.push({ date, close: a }); prices.B.push({ date, close: b });
  });
  return { basket: [{ symbol: 'A', weight: 0.6 }, { symbol: 'B', weight: 0.4 }],
    calendarRows: dates.map((date) => ({ date })), prices, cor1mRows: dates.map((date) => ({ date, close: 25 })) };
}

test('pivoted standardized OLS recovers known coefficients and rejects collinearity', () => {
  const samples = Array.from({ length: 600 }, (_, i) => {
    const x = [Math.sin(i), Math.cos(i / 3), Math.sin(i / 7), Math.cos(i / 13)].map((v, j) => v * (j + 1) * 10 + 30);
    return { x, y: 5 + 0.2 * x[0] - 0.4 * x[1] + 0.9 * x[2] + 0.7 * x[3] };
  });
  const coefficients = fitHarOls(samples);
  [5, 0.2, -0.4, 0.9, 0.7].forEach((expected, i) => assert.ok(Math.abs(Object.values(coefficients)[i] - expected) < 1e-10));
  assert.throws(() => fitHarOls(samples.map((row) => ({ ...row, x: [1, 1, 1, 1] }))), /rank deficient/);
  assert.throws(() => fitHarOls(samples.map((row) => ({ ...row, x: [...row.x.slice(0, 3), row.x[0]] }))), /rank deficient/);
});

test('targets are exactly 21 future sessions, samples are capped and never use unfinished outcomes', () => {
  const series = Array.from({ length: 1500 }, (_, i) => ({ date: String(i), rc5: i, rc10: i + 1, rc21: i + 2, rcEwma: i + 3 }));
  const samples = buildHarSamples(series);
  assert.equal(samples.length, 1260);
  assert.equal(samples.at(-1).date, '1478');
  assert.equal(samples.at(-1).targetDate, '1499');
  assert.equal(samples.at(-1).y, 1501);
  assert.deepEqual(samples.at(-1).x, [1478, 1479, 1480, 1481]);
  series.at(-1).rc21 = null;
  assert.equal(buildHarSamples(series).at(-1).date, '1477');
});

test('forecast is fitted to completed outcomes, COR1M is comparison only, and short history fails', () => {
  const data = inputs();
  const result = calculateHarForecast(data);
  assert.equal(result.date, data.calendarRows.at(-1).date);
  assert.equal(result.training.samples, 629);
  assert.equal(result.training.lastTargetDate, result.date);
  assert.ok(Number.isFinite(result.forecast));
  assert.equal(result.spread, result.forecast - 25);
  assert.equal(result.fact, null);
  const withoutCor = calculateHarForecast({ ...data, cor1mRows: [] });
  assert.equal(withoutCor.forecast, result.forecast);
  assert.equal(withoutCor.cor1m, null);
  assert.throws(() => calculateHarForecast(inputs(600)), /at least 504/);
  const broken = structuredClone(data);
  broken.prices.A.pop();
  assert.throws(() => calculateHarForecast(broken), /Incomplete HAR factors/);
});

test('fact matures after exactly 21 sessions using the original basket and preserves gaps', () => {
  const data = inputs(80);
  const origin = 35;
  const record = { date: data.calendarRows[origin].date, basket: data.basket, model: HAR_MODEL, forecast: 30, fact: null, error: null, targetEndDate: null };
  assert.equal(matureHarForecast(record, data.calendarRows.slice(0, origin + 21), data.prices).fact, null);
  const matured = matureHarForecast(record, data.calendarRows, data.prices);
  const expected = calculateRealizedCorrelationSeries({ ...data, calendarRows: data.calendarRows.slice(origin, origin + 22) }).latest.rc21;
  assert.equal(matured.fact, expected);
  assert.equal(matured.error, 30 - expected);
  assert.equal(matured.targetEndDate, data.calendarRows[origin + 21].date);
  const changed = structuredClone(data.prices);
  changed.A = changed.A.filter((row) => row.date !== data.calendarRows[origin + 3].date);
  assert.equal(matureHarForecast(record, data.calendarRows, changed).fact, null);
  assert.deepEqual(matureHarForecast(matured, data.calendarRows, changed), matured);
});

test('worker computes a real forecast and reports model failures without losing matured records', async () => {
  const run = (inputs) => new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../src/main/correlation-har-worker.cjs', import.meta.url), { workerData: { inputs, records: [], makeForecast: true } });
    worker.once('message', resolve); worker.once('error', reject);
  });
  const valid = await run(inputs());
  assert.ok(Number.isFinite(valid.forecast.forecast));
  const invalid = await run(inputs(100));
  assert.match(invalid.error, /504/);
  assert.deepEqual(invalid.records, []);
});
