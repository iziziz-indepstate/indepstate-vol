export const VIXEQ_LAUNCH_DATE = '2024-11-04';
export const CONTEXT_SESSIONS = 252;
export const VIXEQ_SERIES = ['vixeq', 'vix', 'cor1m'];
export const VIXEQ_METRICS = [...VIXEQ_SERIES, 'spread'];

function change(current, earlier) {
  return current == null || earlier == null ? null : current - earlier;
}

function changes(row, earlier) {
  const vixeq = change(row.vixeq, earlier?.vixeq);
  const vix = change(row.vix, earlier?.vix);
  return {
    vixeq,
    vix,
    spread: vixeq === null || vix === null ? null : vixeq - vix,
    cor1m: change(row.cor1m, earlier?.cor1m)
  };
}

function historicalStats(previous) {
  const count = previous.length;
  if (count < CONTEXT_SESSIONS) return { count, sigma: null, origin: null, meanOffset: null };
  // Center around the first value so constant history has exact zero variance.
  const origin = previous[0];
  const meanOffset = previous.reduce((sum, value) => sum + (value - origin), 0) / count;
  const variance = previous.reduce((sum, value) => sum + (value - origin - meanOffset) ** 2, 0) / count;
  return { count, sigma: Math.sqrt(variance), origin, meanOffset };
}

function levelHistory(rows, index, key) {
  return historicalStats(rows.slice(Math.max(0, index - CONTEXT_SESSIONS), index).map((row) => row[key]).filter(Number.isFinite));
}

function zScore(rows, index, key) {
  const current = rows[index][key];
  if (current === null || index < CONTEXT_SESSIONS) return null;
  const { sigma, origin, meanOffset } = levelHistory(rows, index, key);
  return sigma > 0 ? (current - origin - meanOffset) / sigma : null;
}

export function getVixeqRegimeObservations(rows, index = rows.length - 1) {
  const byMetric = (callback) => Object.fromEntries(VIXEQ_METRICS.map((key) => [key, callback(key)]));
  const momentum = Object.fromEntries([5, 20].map((horizon) => [horizon, byMetric((key) => {
    const previous = [];
    for (let i = index - 1; i >= 0 && previous.length < CONTEXT_SESSIONS; i -= 1) {
      const value = rows[i][`change${horizon}`][key];
      if (Number.isFinite(value)) previous.push(value);
    }
    const { count, sigma } = historicalStats(previous);
    return { count, sigma };
  })]));
  const levels = byMetric((key) => {
    const { count, sigma } = levelHistory(rows, index, key);
    return { count, sigma };
  });
  return { levels, momentum };
}

export function calculateVixeqDynamics(sessions, histories) {
  const closes = Object.fromEntries(VIXEQ_SERIES.map((key) => [
    key, new Map(histories[key].filter(({ close }) => Number.isFinite(close)).map(({ date, close }) => [date, close]))
  ]));
  const rows = sessions.map((date) => {
    const vixeq = closes.vixeq.get(date) ?? null;
    const vix = closes.vix.get(date) ?? null;
    return {
      date, vixeq, vix, spread: change(vixeq, vix), cor1m: closes.cor1m.get(date) ?? null,
      retrospective: vixeq !== null && date < VIXEQ_LAUNCH_DATE
    };
  });
  return rows.map((row, index) => ({
    ...row,
    change5: changes(row, rows[index - 5]),
    change20: changes(row, rows[index - 20]),
    zScore: Object.fromEntries(VIXEQ_METRICS.map((key) => [key, zScore(rows, index, key)]))
  }));
}

function direction(value) {
  return Math.abs(value) < 1e-10 ? 0 : Math.sign(value);
}

export function describeVixeqDynamics(row) {
  if (!row) return '';
  const { spread, vixeq, vix, cor1m } = row.change5;
  let spreadText = 'Spread change unavailable';
  if (spread !== null) {
    const motion = direction(spread);
    const drivers = [];
    if (motion && Math.sign(vixeq) === motion) drivers.push(motion > 0 ? 'rising VIXEQ' : 'falling VIXEQ');
    if (motion && Math.sign(-vix) === motion) drivers.push(motion > 0 ? 'falling VIX' : 'rising VIX');
    spreadText = motion === 0 ? 'Spread unchanged'
      : `Spread ${motion > 0 ? 'widening' : 'narrowing'} with ${drivers.join(' and ')}`;
  }
  const correlation = cor1m === null ? 'COR1M change unavailable'
    : `COR1M ${direction(cor1m) > 0 ? 'rising' : direction(cor1m) < 0 ? 'falling' : 'unchanged'}`;
  return `${spreadText} · ${correlation}`;
}

const VOLATILITY_MOVES = { '-1': 'fell', 0: 'held steady', 1: 'rose' };
const CORRELATION_EXPLANATIONS = {
  '-1': 'Options price in weaker co-movement among stocks.',
  0: 'The degree of co-movement implied by options held steady.',
  1: 'Options price in stronger co-movement among stocks.'
};

function explainVolatility({ vixeq, vix, spread }) {
  const stocks = vixeq === null ? null : direction(vixeq);
  const index = vix === null ? null : direction(vix);
  if (stocks === null && index === null) return '';
  if (stocks === null) return `Expected volatility ${VOLATILITY_MOVES[index]} for the S&P 500 index.`;
  if (index === null) return `Expected volatility ${VOLATILITY_MOVES[stocks]} for individual S&P 500 stocks.`;
  if (stocks !== index) {
    return `Expected volatility ${VOLATILITY_MOVES[stocks]} for individual S&P 500 stocks while it ${VOLATILITY_MOVES[index]} for the index as a whole.`;
  }
  const difference = direction(spread);
  const detail = stocks && difference
    ? `, with a larger ${stocks > 0 ? 'increase' : 'decrease'} for ${difference === stocks ? 'individual stocks' : 'the index'}`
    : '';
  return `Expected volatility ${VOLATILITY_MOVES[stocks]} for both individual S&P 500 stocks and the index${detail}.`;
}

export function explainVixeqDynamics(row) {
  if (!row) return '';
  const { change5 } = row;
  const correlation = change5.cor1m === null ? '' : CORRELATION_EXPLANATIONS[direction(change5.cor1m)];
  return [explainVolatility(change5), correlation].filter(Boolean).join(' ');
}
