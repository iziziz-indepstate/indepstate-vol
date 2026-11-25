export const VIX_RESPONSE_MODEL = Object.freeze({
  method: 'rolling-ols', windowSessions: 60, spxReturnUnit: 'percent', vixChangeUnit: 'points'
});

export function calculateResidualBands(series) {
  const residuals = series.map((row) => row.residual).filter(Number.isFinite);
  const count = residuals.length;
  if (count < 2) return null;

  const mean = residuals.reduce((sum, value) => sum + value, 0) / count;
  const variance = residuals.reduce((sum, value) => sum + (value - mean) ** 2, 0) / count;
  const sigma = Math.sqrt(variance);
  return { count, mean, sigma, lower: mean - 3 * sigma, upper: mean + 3 * sigma };
}

function change(previous, current, relative = false) {
  if (!Number.isFinite(previous) || previous <= 0 || !Number.isFinite(current) || current <= 0) return null;
  return relative ? 100 * (current / previous - 1) : current - previous;
}

function fitResponse(training) {
  if (training.some((row) => row.spxReturn === null || row.actualChange === null)) return null;
  const count = training.length;
  const meanX = training.reduce((sum, row) => sum + row.spxReturn, 0) / count;
  const meanY = training.reduce((sum, row) => sum + row.actualChange, 0) / count;
  let variance = 0;
  let covariance = 0;
  for (const row of training) {
    const dx = row.spxReturn - meanX;
    variance += dx * dx;
    covariance += dx * (row.actualChange - meanY);
  }
  // Identical returns may differ by floating-point roundoff after conversion to percent.
  if (variance <= count * (Number.EPSILON * Math.max(100, Math.abs(meanX))) ** 2) return null;
  const beta = covariance / variance;
  return { alpha: meanY - beta * meanX, beta };
}

export function calculateVixResponse({ sessions, spxBars, vixBars }) {
  const spx = new Map(spxBars.map(({ date, close }) => [date, close]));
  const vix = new Map(vixBars.map(({ date, close }) => [date, close]));
  const daily = sessions.map((date, index) => ({
    date,
    spxReturn: change(spx.get(sessions[index - 1]), spx.get(date), true),
    actualChange: change(vix.get(sessions[index - 1]), vix.get(date))
  }));
  const { windowSessions } = VIX_RESPONSE_MODEL;
  return daily.map((row, index) => {
    const coefficients = index > windowSessions ? fitResponse(daily.slice(index - windowSessions, index)) : null;
    const expectedChange = coefficients && row.spxReturn !== null
      ? coefficients.alpha + coefficients.beta * row.spxReturn : null;
    const residual = expectedChange !== null && row.actualChange !== null ? row.actualChange - expectedChange : null;
    return { ...row, expectedChange, residual, coefficients };
  });
}
