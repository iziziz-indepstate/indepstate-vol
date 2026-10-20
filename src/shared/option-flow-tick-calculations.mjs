import { parseOptionFlowStrikeWindow } from './option-flow-strike-window.mjs';

const SERIES = [
  { key: 'boughtCalls', label: 'Bought calls', color: '#22c55e', type: 'CALL', side: 'BUY' },
  { key: 'soldCalls', label: 'Sold calls', color: '#ef4444', type: 'CALL', side: 'SELL' },
  { key: 'boughtPuts', label: 'Bought puts', color: '#38bdf8', type: 'PUT', side: 'BUY' },
  { key: 'soldPuts', label: 'Sold puts', color: '#f59e0b', type: 'PUT', side: 'SELL' }
];

const BALANCED_SERIES = [
  { key: 'callsBalance', label: 'Calls balance', color: '#22c55e' },
  { key: 'putsBalance', label: 'Puts balance', color: '#38bdf8' },
  { key: 'directionalBalance', label: 'Directional balance', color: '#f59e0b' },
  { key: 'imbalance', label: 'Imbalance', color: '#a855f7' }
];

const FLOW_DISPLAY_MODES = Object.freeze({
  CUMULATIVE: 'cumulative',
  LINEAR: 'linear',
  MA_1M: 'ma-1m',
  MA_3M: 'ma-3m',
  MA_5M: 'ma-5m',
  MA_15M: 'ma-15m'
});

const FLOW_DISPLAY_WINDOW_MINUTES = Object.freeze({
  [FLOW_DISPLAY_MODES.MA_1M]: 1,
  [FLOW_DISPLAY_MODES.MA_3M]: 3,
  [FLOW_DISPLAY_MODES.MA_5M]: 5,
  [FLOW_DISPLAY_MODES.MA_15M]: 15
});

function toNumber(value) {
  const normalized = typeof value === 'string' ? value.trim().replace(/[$,%\s]/g, '') : value;
  if (normalized == null || normalized === '') return null;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function tapeRecords(snapshot) {
  return Array.isArray(snapshot?.tape?.records) ? snapshot.tape.records : [];
}

function labelForTime(value) {
  const dt = new Date(value || 0);
  return Number.isNaN(dt.getTime()) ? String(value || '') : dt.toLocaleTimeString();
}

function timeMs(value) {
  const dt = new Date(value || 0);
  return Number.isNaN(dt.getTime()) ? null : dt.getTime();
}

function strikesAroundAtm(records, px, strikeWindow) {
  const strikes = Array.from(new Set(
    records
      .map((record) => toNumber(record?.strike))
      .filter(Number.isFinite)
  )).sort((a, b) => a - b);
  if (strikeWindow === 'ALL') return new Set(strikes);
  if (!Number.isFinite(px)) return new Set();
  if (!strikes.length) return new Set();
  let atmIdx = 0;
  for (let idx = 1; idx < strikes.length; idx += 1) {
    if (Math.abs(strikes[idx] - px) < Math.abs(strikes[atmIdx] - px)) atmIdx = idx;
  }
  const count = Math.abs(Number(strikeWindow));
  const from = Math.max(0, atmIdx - (String(strikeWindow).startsWith('+') ? 0 : count));
  const to = Math.min(strikes.length - 1, atmIdx + (String(strikeWindow).startsWith('-') ? 0 : count));
  return new Set(strikes.slice(from, to + 1));
}

function snapshotPx(snapshot, records) {
  const direct = toNumber(snapshot?.px);
  if (Number.isFinite(direct) && direct > 0) return direct;
  return records
    .map((record) => toNumber(record?.underlying_price))
    .find((value) => Number.isFinite(value) && value > 0) ?? null;
}

function recordBucket(record, allowedStrikes) {
  const size = toNumber(record?.size_contracts);
  const strike = toNumber(record?.strike);
  const type = String(record?.call_put || '').trim().toUpperCase();
  const side = String(record?.aggressor_buy_sell || '').trim().toUpperCase();
  if (!Number.isFinite(strike) || !Number.isFinite(size) || size <= 0) return null;
  if (!allowedStrikes.has(strike)) return null;
  return SERIES.find((series) => series.type === type && series.side === side)?.key || null;
}

function normalizeFlowDisplayMode(value) {
  return Object.values(FLOW_DISPLAY_MODES).includes(value) ? value : FLOW_DISPLAY_MODES.CUMULATIVE;
}

function emptySeriesValues() {
  return Object.fromEntries(SERIES.map((series) => [series.key, 0]));
}

function balancesFromTotals(totals) {
  const callsBalance = totals.boughtCalls - totals.soldCalls;
  const putsBalance = totals.boughtPuts - totals.soldPuts;
  const directionalBalance = callsBalance - putsBalance;
  const grossContracts = totals.boughtCalls + totals.soldCalls + totals.boughtPuts + totals.soldPuts;
  return {
    callsBalance,
    putsBalance,
    directionalBalance,
    imbalance: grossContracts > 0 ? directionalBalance / grossContracts : 0
  };
}

function windowTotals(points, pointIdx, windowMinutes) {
  const currentMs = points[pointIdx]?.timeMs;
  if (!Number.isFinite(currentMs)) return { ...points[pointIdx]?.increments };

  const fromMs = currentMs - (windowMinutes * 60 * 1000);
  const totals = emptySeriesValues();
  for (let idx = 0; idx <= pointIdx; idx += 1) {
    const point = points[idx];
    if (!Number.isFinite(point?.timeMs)) continue;
    if (point.timeMs < fromMs || point.timeMs > currentMs) continue;
    for (const series of SERIES) totals[series.key] += point.increments[series.key];
  }
  return totals;
}

function calculateFlowPoints(history, config = {}) {
  const strikeWindow = parseOptionFlowStrikeWindow(config.strikeWindow ?? config.strikeRange) ?? 3;
  const labels = [];
  const totals = emptySeriesValues();
  const meta = [];

  for (const snapshot of Array.isArray(history) ? history : []) {
    if (snapshot?.provider !== 'tape-contract' || snapshot?.gammaClock) continue;
    const records = tapeRecords(snapshot);
    const px = snapshotPx(snapshot, records);
    const allowedStrikes = strikesAroundAtm(records, px, strikeWindow);
    const increments = Object.fromEntries(SERIES.map((series) => [series.key, 0]));
    let matchedRecords = 0;

    for (const record of records) {
      const bucket = recordBucket(record, allowedStrikes);
      if (!bucket) continue;
      const size = toNumber(record.size_contracts);
      increments[bucket] += size;
      matchedRecords += 1;
    }

    for (const series of SERIES) totals[series.key] += increments[series.key];
    labels.push(labelForTime(snapshot.time));
    meta.push({
      timestamp: snapshot.time,
      timeMs: timeMs(snapshot.time),
      px,
      strikeWindow,
      atmSource: snapshot.atmSource || null,
      allowedStrikes: Array.from(allowedStrikes),
      records: records.length,
      matchedRecords,
      increments: { ...increments },
      totals: { ...totals },
      balances: balancesFromTotals(totals)
    });
  }

  return { labels, meta, strikeWindow };
}

function applyFlowDisplayMode(meta, config = {}) {
  const displayMode = normalizeFlowDisplayMode(config.flowDisplayMode);
  const windowMinutes = FLOW_DISPLAY_WINDOW_MINUTES[displayMode] || null;
  if (displayMode === FLOW_DISPLAY_MODES.LINEAR) {
    return meta.map((point) => ({
      ...point,
      displayMode,
      flowWindowMinutes: null,
      displayTotals: { ...point.increments },
      displayBalances: balancesFromTotals(point.increments)
    }));
  }
  if (!windowMinutes) {
    return meta.map((point) => ({
      ...point,
      displayMode,
      flowWindowMinutes: null,
      displayTotals: { ...point.totals },
      displayBalances: { ...point.balances }
    }));
  }

  return meta.map((point, idx) => {
    const displayTotals = windowTotals(meta, idx, windowMinutes);
    return {
      ...point,
      displayMode,
      flowWindowMinutes: windowMinutes,
      displayTotals,
      displayBalances: balancesFromTotals(displayTotals)
    };
  });
}

export function buildOptionFlowTickSeries(history, config = {}) {
  const { labels, meta: rawMeta, strikeWindow } = calculateFlowPoints(history, config);
  const meta = applyFlowDisplayMode(rawMeta, config);
  const values = Object.fromEntries(SERIES.map((series) => [series.key, []]));

  for (const point of meta) {
    for (const series of SERIES) values[series.key].push(point.displayTotals[series.key]);
  }

  return {
    labels,
    datasets: SERIES.map((series) => ({
      seriesKey: series.key,
      label: series.label,
      data: values[series.key],
      borderColor: series.color,
      pointMeta: meta
    })),
    summary: {
      strikeWindow,
      flowDisplayMode: normalizeFlowDisplayMode(config.flowDisplayMode),
      flowWindowMinutes: FLOW_DISPLAY_WINDOW_MINUTES[normalizeFlowDisplayMode(config.flowDisplayMode)] || null,
      totals: meta.at(-1)?.displayTotals || emptySeriesValues()
    }
  };
}

export function buildOptionFlowBalancedTickSeries(history, config = {}) {
  const { labels, meta: rawMeta, strikeWindow } = calculateFlowPoints(history, config);
  const meta = applyFlowDisplayMode(rawMeta, config);
  const values = Object.fromEntries(BALANCED_SERIES.map((series) => [series.key, []]));

  for (const point of meta) {
    for (const series of BALANCED_SERIES) values[series.key].push(point.displayBalances[series.key]);
  }

  return {
    labels,
    datasets: BALANCED_SERIES.map((series) => ({
      seriesKey: series.key,
      label: series.label,
      data: values[series.key],
      borderColor: series.color,
      pointMeta: meta
    })),
    summary: {
      strikeWindow,
      flowDisplayMode: normalizeFlowDisplayMode(config.flowDisplayMode),
      flowWindowMinutes: FLOW_DISPLAY_WINDOW_MINUTES[normalizeFlowDisplayMode(config.flowDisplayMode)] || null,
      balances: meta.at(-1)?.displayBalances || Object.fromEntries(BALANCED_SERIES.map((series) => [series.key, 0]))
    }
  };
}

export { SERIES as OPTION_FLOW_TICK_SERIES };
export { BALANCED_SERIES as OPTION_FLOW_BALANCED_TICK_SERIES };
export { FLOW_DISPLAY_MODES as OPTION_FLOW_DISPLAY_MODES };
