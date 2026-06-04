const DEFAULT_ANNUALIZATION_FACTOR = 252;
const RV_EPSILON = 1e-8;

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeDate(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const date = new Date(`${text.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function normalizeRows(rows, expectedSymbol) {
  if (!Array.isArray(rows)) return [];

  const byDate = new Map();
  for (const row of rows) {
    const date = normalizeDate(row?.date);
    const close = finiteNumber(row?.close);
    const symbol = String(row?.symbol ?? expectedSymbol ?? '').trim().toUpperCase();
    if (!date || close == null || close <= 0) continue;
    if (expectedSymbol && symbol && symbol !== expectedSymbol.toUpperCase()) continue;
    byDate.set(date, { date, symbol: symbol || expectedSymbol || '', close });
  }

  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}

export function resolveHorizon(rawHorizon) {
  const text = String(rawHorizon ?? '').trim().toLowerCase();
  const days = Number.parseInt(text.replace(/d$/, ''), 10);
  if (!Number.isInteger(days) || days < 1) {
    throw new Error('Horizon must be a positive number of trading days');
  }

  const ivSymbol = days === 9 ? 'VIX9D' : days === 30 ? 'VIX' : null;
  return { days, label: `${days}d`, ivSymbol };
}

export function calculateIvRvSeries({
  spxRows,
  ivRows,
  horizon = '9d',
  annualizationFactor = DEFAULT_ANNUALIZATION_FACTOR,
  startDate,
  endDate
}) {
  const resolved = resolveHorizon(horizon);
  const annualization = finiteNumber(annualizationFactor);
  if (annualization == null || annualization <= 0) {
    throw new Error('Annualization factor must be positive');
  }

  const spx = normalizeRows(spxRows, 'SPX');
  const iv = normalizeRows(ivRows, resolved.ivSymbol);
  if (spx.length < resolved.days + 1) {
    throw new Error('Not enough SPX history for selected horizon');
  }
  if (!iv.length) {
    throw new Error('Missing local IV source for selected horizon');
  }

  const start = normalizeDate(startDate);
  const end = normalizeDate(endDate);
  const rvByDate = new Map();
  const squaredReturns = [];

  for (let index = 1; index < spx.length; index += 1) {
    const logReturn = Math.log(spx[index].close / spx[index - 1].close);
    squaredReturns.push(logReturn * logReturn);
    if (squaredReturns.length > resolved.days) squaredReturns.shift();
    if (squaredReturns.length !== resolved.days) continue;

    const sumSquares = squaredReturns.reduce((sum, value) => sum + value, 0);
    const rv = Math.sqrt((annualization / resolved.days) * sumSquares) * 100;
    rvByDate.set(spx[index].date, {
      date: spx[index].date,
      spx_close: spx[index].close,
      rv
    });
  }

  const output = [];
  for (const ivRow of iv) {
    if (start && ivRow.date < start) continue;
    if (end && ivRow.date > end) continue;
    const rvRow = rvByDate.get(ivRow.date);
    if (!rvRow) continue;

    const ratiosAvailable = rvRow.rv > RV_EPSILON;
    output.push({
      date: ivRow.date,
      horizon: resolved.label,
      spx_close: rvRow.spx_close,
      iv_symbol: ivRow.symbol || resolved.ivSymbol || 'IV',
      iv: ivRow.close,
      rv: rvRow.rv,
      vol_spread: ivRow.close - rvRow.rv,
      vol_ratio: ratiosAvailable ? ivRow.close / rvRow.rv : null,
      variance_ratio: ratiosAvailable ? (ivRow.close * ivRow.close) / (rvRow.rv * rvRow.rv) : null,
      ratio_warning: ratiosAvailable ? null : 'RV is too close to zero for ratios'
    });
  }

  if (!output.length) {
    throw new Error('No overlapping dates between SPX and IV datasets');
  }

  return {
    horizon: resolved,
    latestSpxDate: spx.at(-1)?.date || null,
    series: output
  };
}

