const SERIES = [
  { key: 'boughtCalls', label: 'Bought calls', color: '#22c55e', type: 'CALL', side: 'BUY' },
  { key: 'soldCalls', label: 'Sold calls', color: '#ef4444', type: 'CALL', side: 'SELL' },
  { key: 'boughtPuts', label: 'Bought puts', color: '#38bdf8', type: 'PUT', side: 'BUY' },
  { key: 'soldPuts', label: 'Sold puts', color: '#f59e0b', type: 'PUT', side: 'SELL' }
];

function toNumber(value) {
  const normalized = typeof value === 'string' ? value.trim().replace(/[$,%\s]/g, '') : value;
  if (normalized == null || normalized === '') return null;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function normalizeStrikeWindow(value) {
  const number = Math.abs(Number(value));
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 3;
}

function tapeRecords(snapshot) {
  return Array.isArray(snapshot?.tape?.records) ? snapshot.tape.records : [];
}

function labelForTime(value) {
  const dt = new Date(value || 0);
  return Number.isNaN(dt.getTime()) ? String(value || '') : dt.toLocaleTimeString();
}

function strikesAroundAtm(records, px, strikeWindow) {
  if (!Number.isFinite(px)) return new Set();
  const strikes = Array.from(new Set(
    records
      .map((record) => toNumber(record?.strike))
      .filter(Number.isFinite)
  )).sort((a, b) => a - b);
  if (!strikes.length) return new Set();
  let atmIdx = 0;
  for (let idx = 1; idx < strikes.length; idx += 1) {
    if (Math.abs(strikes[idx] - px) < Math.abs(strikes[atmIdx] - px)) atmIdx = idx;
  }
  const from = Math.max(0, atmIdx - strikeWindow);
  const to = Math.min(strikes.length - 1, atmIdx + strikeWindow);
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

export function buildOptionFlowTickSeries(history, config = {}) {
  const strikeWindow = normalizeStrikeWindow(config.strikeWindow ?? config.strikeRange);
  const labels = [];
  const totals = Object.fromEntries(SERIES.map((series) => [series.key, 0]));
  const values = Object.fromEntries(SERIES.map((series) => [series.key, []]));
  const meta = [];

  for (const snapshot of Array.isArray(history) ? history : []) {
    if (snapshot?.provider !== 'tape-contract') continue;
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
    for (const series of SERIES) values[series.key].push(totals[series.key]);
    meta.push({
      timestamp: snapshot.time,
      px,
      strikeWindow,
      atmSource: snapshot.atmSource || null,
      allowedStrikes: Array.from(allowedStrikes),
      records: records.length,
      matchedRecords,
      increments: { ...increments },
      totals: { ...totals }
    });
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
      totals
    }
  };
}

export { SERIES as OPTION_FLOW_TICK_SERIES };
