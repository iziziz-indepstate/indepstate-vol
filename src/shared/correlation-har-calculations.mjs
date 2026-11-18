import { calculateRealizedCorrelationSeries } from './realized-correlation-calculations.mjs';

export const HAR_MODEL = Object.freeze({ version: 1, horizon: 21, maxSamples: 1260, minSamples: 504,
  ewmaHalfLife: 10, warmup: 100, method: 'OLS', features: ['rc5', 'rc10', 'rc21', 'rcEwma'] });
const features = (row) => HAR_MODEL.features.map((key) => row[key]);
const finite = (values) => values.every(Number.isFinite);
const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);

// Pivoted QR with reorthogonalization. Work with centered, standardized columns,
// and recover the intercept and coefficients in correlation points afterwards.
export function fitHarOls(samples) {
  const n = samples.length;
  if (n < 5 || samples.some(({ x, y }) => x.length !== 4 || !finite([...x, y]))) throw new Error('Invalid OLS samples');
  const means = [0, 1, 2, 3].map((j) => samples.reduce((s, row) => s + row.x[j], 0) / n);
  const scales = means.map((mean, j) => Math.sqrt(samples.reduce((s, row) => s + (row.x[j] - mean) ** 2, 0) / n));
  if (scales.some((scale) => !(scale > 1e-12))) throw new Error('HAR factors are rank deficient');
  const yMean = samples.reduce((s, row) => s + row.y, 0) / n;
  const y = samples.map((row) => row.y - yMean);
  const columns = means.map((mean, j) => samples.map((row) => (row.x[j] - mean) / scales[j]));
  const order = [0, 1, 2, 3], r = Array.from({ length: 4 }, () => Array(4).fill(0)), qty = [];
  for (let k = 0; k < 4; k += 1) {
    let pivot = k;
    for (let j = k + 1; j < 4; j += 1) if (dot(columns[j], columns[j]) > dot(columns[pivot], columns[pivot])) pivot = j;
    [columns[k], columns[pivot]] = [columns[pivot], columns[k]];
    [order[k], order[pivot]] = [order[pivot], order[k]];
    for (let i = 0; i < k; i += 1) [r[i][k], r[i][pivot]] = [r[i][pivot], r[i][k]];
    r[k][k] = Math.sqrt(dot(columns[k], columns[k]));
    if (r[k][k] < Math.sqrt(n) * 1e-9) throw new Error('HAR factors are rank deficient');
    const q = columns[k].map((value) => value / r[k][k]);
    qty[k] = dot(q, y);
    for (let j = k + 1; j < 4; j += 1) {
      for (let pass = 0; pass < 2; pass += 1) {
        const projection = dot(q, columns[j]);
        r[k][j] += projection;
        columns[j] = columns[j].map((value, i) => value - projection * q[i]);
      }
    }
  }
  const solution = Array(4).fill(0), beta = Array(4).fill(0);
  for (let i = 3; i >= 0; i -= 1) solution[i] = (qty[i] - r[i].reduce((s, value, j) => s + (j > i ? value * solution[j] : 0), 0)) / r[i][i];
  order.forEach((original, i) => { beta[original] = solution[i] / scales[original]; });
  const intercept = yMean - dot(means, beta);
  if (!finite([intercept, ...beta])) throw new Error('Nonfinite HAR coefficients');
  return { intercept, ...Object.fromEntries(HAR_MODEL.features.map((name, i) => [name, beta[i]])) };
}

export function buildHarSamples(series) {
  const samples = [];
  for (let i = HAR_MODEL.warmup - 1; i + HAR_MODEL.horizon < series.length; i += 1) {
    const x = features(series[i]), target = series[i + HAR_MODEL.horizon];
    if (finite(x) && Number.isFinite(target.rc21)) samples.push({ date: series[i].date, targetDate: target.date, x, y: target.rc21 });
  }
  return samples.slice(-HAR_MODEL.maxSamples);
}

export function calculateHarForecast({ basket, calendarRows, prices, cor1mRows = [] }) {
  const { series, latest } = calculateRealizedCorrelationSeries({ basket, calendarRows, prices, cor1mRows, ewmaHalfLife: 10 });
  const samples = buildHarSamples(series);
  if (samples.length < HAR_MODEL.minSamples) throw new Error(`HAR needs at least 504 completed training samples; available: ${samples.length}`);
  const x = features(latest);
  if (!finite(x)) throw new Error(`Incomplete HAR factors for latest session ${latest.date}`);
  const coefficients = fitHarOls(samples);
  const forecast = coefficients.intercept + HAR_MODEL.features.reduce((sum, key) => sum + coefficients[key] * latest[key], 0);
  if (!Number.isFinite(forecast)) throw new Error('Nonfinite HAR forecast');
  return { date: latest.date, forecast, cor1m: latest.cor1m, spread: latest.cor1m === null ? null : forecast - latest.cor1m,
    factors: Object.fromEntries(HAR_MODEL.features.map((key) => [key, latest[key]])), coefficients,
    training: { samples: samples.length, startDate: samples[0].date, endDate: samples.at(-1).date, lastTargetDate: samples.at(-1).targetDate },
    model: HAR_MODEL, fact: null, error: null, targetEndDate: null,
    warnings: forecast < -100 || forecast > 100 ? ['OLS forecast is outside the mathematical correlation range (-100…100).'] : [] };
}

export function matureHarForecast(record, calendarRows, prices) {
  if (record.fact !== null) return record;
  const dates = [...new Set(calendarRows.map((row) => row.date))].sort();
  const origin = dates.indexOf(record.date), end = origin + record.model.horizon;
  if (origin < 0 || end >= dates.length) return record;
  const window = dates.slice(origin, end + 1).map((date) => ({ date }));
  try {
    const result = calculateRealizedCorrelationSeries({ basket: record.basket, calendarRows: window, prices });
    const fact = result.latest.rc21;
    return { ...record, targetEndDate: dates[end], fact, error: fact === null ? null : record.forecast - fact };
  } catch (_) {
    // Keep incomplete outcomes pending, rather than shortening the target window.
    return { ...record, targetEndDate: dates[end] };
  }
}
