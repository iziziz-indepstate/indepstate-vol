const WINDOWS = [5, 10, 21];

export function resolveEwmaConfig(rawHalfLife = 10) {
  const halfLife = Number(rawHalfLife);
  if (!Number.isInteger(halfLife) || halfLife < 1 || halfLife > 63) {
    throw new Error('EWMA half-life must be an integer from 1 to 63 trading sessions');
  }
  return { halfLife, lambda: 2 ** (-1 / halfLife), lookbackSessions: Math.max(21, 10 * halfLife),
    minObservations: 21, method: 'exponentially-weighted-centered-covariance' };
}

function sampleVariance(values, timeWeights) {
  const mean = timeWeights
    ? values.reduce((sum, value, i) => sum + timeWeights[i] * value, 0)
    : values.reduce((sum, value) => sum + value, 0) / values.length;
  return timeWeights
    ? values.reduce((sum, value, i) => sum + timeWeights[i] * (value - mean) ** 2, 0)
    : values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
}

function correlation(returns, weights, timeWeights) {
  const variances = weights.map((_, index) => sampleVariance(returns.map((row) => row[index]), timeWeights));
  const basketVariance = sampleVariance(returns.map((row) => row.reduce((sum, value, index) => sum + weights[index] * value, 0)), timeWeights);
  const individualVariance = variances.reduce((sum, value, index) => sum + weights[index] ** 2 * value, 0);
  const riskSum = variances.reduce((sum, value, index) => sum + weights[index] * Math.sqrt(value), 0);
  const denominator = riskSum ** 2 - individualVariance;
  if (!(denominator > Number.EPSILON * riskSum ** 2)) return null;
  const value = 100 * (basketVariance - individualVariance) / denominator;
  // Only round off floating point noise at the mathematical bounds.
  return Number.isFinite(value) ? Math.max(-100, Math.min(100, value)) : null;
}

export function calculateRealizedCorrelationSeries({ basket, calendarRows, prices, cor1mRows = [], startDate = '', endDate = '', ewmaHalfLife = 10 }) {
  const ewma = resolveEwmaConfig(ewmaHalfLife);
  if (!Array.isArray(basket) || basket.length < 2) throw new Error('Correlation requires at least two components');
  if (new Set(basket.map((row) => row.symbol)).size !== basket.length
    || basket.some((row) => !Number.isFinite(row.weight) || row.weight <= 0)) throw new Error('Invalid basket weights or duplicate components');
  const total = basket.reduce((sum, row) => sum + row.weight, 0);
  if (!Number.isFinite(total)) throw new Error('Invalid basket weights');
  const weights = basket.map((row) => row.weight / total);
  const dates = [...new Set((calendarRows || []).map((row) => row.date))].filter((date) => !endDate || date <= endDate).sort();
  const maps = basket.map(({ symbol }) => new Map((prices[symbol] || []).map((row) => [row.date, row.close])));
  const implied = new Map(cor1mRows.filter((row) => Number.isFinite(row.close)).map((row) => [row.date, row.close]));
  const returns = [];
  const ewmaReturns = [];
  const timeWeightsByLength = new Map();
  const series = [];
  for (let i = 1; i < dates.length; i += 1) {
    const row = maps.map((map) => {
      const previous = map.get(dates[i - 1]);
      const current = map.get(dates[i]);
      return previous > 0 && current > 0 && Number.isFinite(previous) && Number.isFinite(current) ? Math.log(current / previous) : null;
    });
    const complete = row.every((value) => value !== null);
    returns.push(complete ? row : null);
    if (returns.length > 21) returns.shift();
    if (complete) {
      ewmaReturns.push(row);
      if (ewmaReturns.length > ewma.lookbackSessions) ewmaReturns.shift();
    } else ewmaReturns.length = 0;
    if (startDate && dates[i] < startDate) continue;
    const point = { date: dates[i] };
    for (const days of WINDOWS) {
      const window = returns.slice(-days);
      point[`rc${days}`] = window.length === days && window.every(Boolean) ? correlation(window, weights) : null;
    }
    point.rcEwma = null;
    if (ewmaReturns.length >= ewma.minObservations) {
      const count = ewmaReturns.length;
      if (!timeWeightsByLength.has(count)) {
        const raw = Array.from({ length: count }, (_, k) => ewma.lambda ** (count - 1 - k));
        const sum = raw.reduce((total, value) => total + value, 0);
        timeWeightsByLength.set(count, raw.map((value) => value / sum));
      }
      point.rcEwma = correlation(ewmaReturns, weights, timeWeightsByLength.get(count));
    }
    point.cor1m = implied.get(point.date) ?? null;
    point.spread = point.cor1m !== null && point.rc21 !== null ? point.cor1m - point.rc21 : null;
    series.push(point);
  }
  if (!series.some((row) => WINDOWS.some((days) => row[`rc${days}`] !== null))) {
    throw new Error('Not enough complete basket history for correlation (minimum 6 consecutive closes)');
  }
  const warnings = [];
  const incomplete = series.filter((row) => row.rc21 === null).length;
  if (incomplete) warnings.push(`RC21 unavailable on ${incomplete} session(s): incomplete history or zero basket risk.`);
  const incompleteEwma = series.filter((row) => row.rcEwma === null).length;
  if (incompleteEwma) warnings.push(`RC EWMA unavailable on ${incompleteEwma} session(s): need 21 consecutive complete returns and nonzero pairwise risk.`);
  return { series, latest: series.at(-1), latestSpxDate: dates.at(-1) || null, ewma, warnings };
}
