import { resolveExpiryToken } from './expiry-placeholders.mjs';

const OPTION_TYPES = new Set(['put', 'call']);
const DEFAULT_DELTAS = 'ATM,90,75,50,25,10,5';

function toNum(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeOptionType(value) {
  const normalized = String(value || '').toLowerCase();
  return OPTION_TYPES.has(normalized) ? normalized : null;
}

function quoteType(quote) {
  return normalizeOptionType(quote?.type || quote?.optionType || quote?.['option-type']);
}

function isValidQuote(quote) {
  const bid = toNum(quote?.bid);
  const ask = toNum(quote?.ask);
  const iv = toNum(quote?.iv);
  const delta = toNum(quote?.delta);
  return Number.isFinite(iv)
    && iv > 0
    && Number.isFinite(delta)
    && Number.isFinite(bid)
    && Number.isFinite(ask)
    && bid >= 0
    && ask > 0
    && ask >= bid;
}

export function normalizeExpiryKey(value) {
  const raw = String(value || '').trim();
  if (/^\d{8}$/.test(raw)) return raw;
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10).replaceAll('-', '');
  return raw;
}

function expiryEntries(snapshot) {
  if (snapshot?.byExpiry && typeof snapshot.byExpiry === 'object') return Object.entries(snapshot.byExpiry);
  if (snapshot?.expiry) return [[snapshot.expiry, snapshot]];
  return [];
}

function findExpirySnapshot(snapshot, expiration) {
  let key = normalizeExpiryKey(resolveExpiryToken(expiration, snapshot?.expiryPlaceholders).value);
  const entries = expiryEntries(snapshot);
  if (!key) key = normalizeExpiryKey(snapshot?.expiry) || normalizeExpiryKey(entries[0]?.[0]);
  const found = entries.find(([candidate]) => normalizeExpiryKey(candidate) === key);
  return { key, snapshot: found?.[1] || null };
}

function sideQuotes(expirySnapshot, side) {
  return (Array.isArray(expirySnapshot?.optionQuotes) ? expirySnapshot.optionQuotes : [])
    .filter((quote) => quoteType(quote) === side)
    .filter(isValidQuote)
    .map((quote) => ({
      ...quote,
      strike: toNum(quote.strike),
      delta: toNum(quote.delta),
      iv: toNum(quote.iv)
    }))
    .filter((quote) => Number.isFinite(quote.strike));
}

function allPairs(expirySnapshot) {
  const pairs = new Map();
  for (const quote of Array.isArray(expirySnapshot?.optionQuotes) ? expirySnapshot.optionQuotes : []) {
    if (!isValidQuote(quote)) continue;
    const type = quoteType(quote);
    const strike = toNum(quote?.strike);
    if (!type || !Number.isFinite(strike)) continue;
    const key = String(strike);
    const pair = pairs.get(key) || { strike, put: null, call: null };
    pair[type] = {
      ...quote,
      strike,
      delta: toNum(quote.delta),
      iv: toNum(quote.iv)
    };
    pairs.set(key, pair);
  }
  return Array.from(pairs.values()).sort((a, b) => a.strike - b.strike);
}

function selectAtmPair(expirySnapshot) {
  const pairs = allPairs(expirySnapshot).filter((pair) => pair.put && pair.call);
  if (!pairs.length) return null;
  const px = toNum(expirySnapshot?.px);
  if (Number.isFinite(px)) {
    return pairs.reduce((best, pair) => (
      Math.abs(pair.strike - px) < Math.abs(best.strike - px) ? pair : best
    ), pairs[0]);
  }
  return pairs.reduce((best, pair) => {
    const distance = Math.abs((toNum(pair.call?.delta) ?? 0.5) + (toNum(pair.put?.delta) ?? -0.5));
    if (!best) return { pair, distance };
    return distance < best.distance ? { pair, distance } : best;
  }, null)?.pair || null;
}

function deltaDistance(quote, side, targetDelta) {
  const delta = toNum(quote?.delta);
  if (!Number.isFinite(delta)) return Number.POSITIVE_INFINITY;
  return side === 'put'
    ? Math.abs(Math.abs(delta) - targetDelta)
    : Math.abs(delta - targetDelta);
}

function selectNearestDeltaQuote(expirySnapshot, side, targetDelta, atmStrike) {
  const candidates = sideQuotes(expirySnapshot, side).filter((quote) => (
    !Number.isFinite(atmStrike)
      ? true
      : (side === 'put' ? quote.strike <= atmStrike : quote.strike >= atmStrike)
  ));
  if (!candidates.length) return null;
  return candidates.reduce((best, quote) => {
    const currDistance = deltaDistance(quote, side, targetDelta);
    const bestDistance = deltaDistance(best, side, targetDelta);
    if (currDistance < bestDistance) return quote;
    if (currDistance > bestDistance) return best;
    return Math.abs(quote.strike - atmStrike) < Math.abs(best.strike - atmStrike) ? quote : best;
  }, candidates[0]);
}

function normalizeDeltaToken(token) {
  const text = String(token || '').trim();
  if (!text) return null;
  if (text.toUpperCase() === 'ATM') return 'ATM';
  const raw = Number(text.replace(/D$/i, ''));
  if (!Number.isFinite(raw)) return null;
  const delta = raw > 1 ? raw / 100 : raw;
  if (!Number.isFinite(delta) || delta <= 0 || delta >= 1) return null;
  return Number(delta.toFixed(4));
}

export function parseIVDynamicsDeltas(value = DEFAULT_DELTAS) {
  const tokens = String(value || DEFAULT_DELTAS).split(/[\s,;|]+/);
  const deltas = [];
  let includeAtm = false;
  for (const token of tokens) {
    const normalized = normalizeDeltaToken(token);
    if (normalized === 'ATM') {
      includeAtm = true;
    } else if (Number.isFinite(normalized) && !deltas.includes(normalized)) {
      deltas.push(normalized);
    }
  }
  if (!includeAtm && !deltas.length) return parseIVDynamicsDeltas(DEFAULT_DELTAS);
  deltas.sort((a, b) => a - b);
  return { includeAtm, deltas };
}

function deltaLabel(delta) {
  return `${Math.round(delta * 100)}D`;
}

export function buildIVDynamicsRows(deltaConfig = DEFAULT_DELTAS) {
  const { includeAtm, deltas } = parseIVDynamicsDeltas(deltaConfig);
  const rows = [
    ...deltas.map((delta) => ({ key: `put-${delta}`, side: 'put', delta, label: `P ${deltaLabel(delta)}` }))
  ];
  if (includeAtm) {
    rows.push(
      { key: 'put-atm', side: 'put', delta: 'ATM', label: 'P ATM', isAtm: true },
      { key: 'call-atm', side: 'call', delta: 'ATM', label: 'C ATM', isAtm: true }
    );
  }
  rows.push(
    ...[...deltas].reverse().map((delta) => ({ key: `call-${delta}`, side: 'call', delta, label: `C ${deltaLabel(delta)}` }))
  );
  return rows;
}

function buildPoint(snapshot, config = {}) {
  const { key: expiration, snapshot: expirySnapshot } = findExpirySnapshot(snapshot, config.expiration);
  const timestamp = snapshot?.time || expirySnapshot?.time || null;
  const rows = buildIVDynamicsRows(config.deltas);
  const atmPair = expirySnapshot ? selectAtmPair(expirySnapshot) : null;
  const atmPutIV = toNum(atmPair?.put?.iv);
  const atmCallIV = toNum(atmPair?.call?.iv);
  const atmValues = [atmPutIV, atmCallIV].filter(Number.isFinite);
  const atmIV = atmValues.length ? atmValues.reduce((acc, value) => acc + value, 0) / atmValues.length : null;
  const warnings = [];
  if (!expirySnapshot) warnings.push(`missing expiration ${expiration || 'primary'}`);
  if (expirySnapshot && !atmPair) warnings.push('missing ATM pair');

  return {
    timestamp,
    expiration,
    atmStrike: toNum(atmPair?.strike),
    atmIV,
    rows: rows.map((row) => {
      let quote = null;
      if (expirySnapshot && atmPair && row.isAtm) quote = atmPair[row.side];
      if (expirySnapshot && atmPair && !row.isAtm) quote = selectNearestDeltaQuote(expirySnapshot, row.side, row.delta, atmPair.strike);
      const iv = toNum(quote?.iv);
      const premium = Number.isFinite(iv) && Number.isFinite(atmIV) ? iv - atmIV : null;
      if (expirySnapshot && !quote) warnings.push(`missing ${row.label}`);
      return {
        ...row,
        timestamp,
        expiration,
        atmStrike: toNum(atmPair?.strike),
        atmIV,
        iv,
        premium,
        value: config.mode === 'iv' ? iv : premium,
        matchedStrike: toNum(quote?.strike),
        matchedDelta: toNum(quote?.delta),
        warning: quote ? null : 'no quote'
      };
    }),
    warnings
  };
}

function findPreviousCell(cells, rowIdx, colIdx) {
  for (let idx = colIdx - 1; idx >= 0; idx -= 1) {
    const candidate = cells[rowIdx]?.[idx];
    if (Number.isFinite(candidate?.value)) return candidate;
  }
  return null;
}

function findCellAtOrBefore(cells, columns, rowIdx, targetMs) {
  if (!Number.isFinite(targetMs)) return null;
  for (let idx = columns.length - 1; idx >= 0; idx -= 1) {
    const timeMs = new Date(columns[idx]?.timestamp || 0).getTime();
    if (!Number.isFinite(timeMs) || timeMs > targetMs) continue;
    const candidate = cells[rowIdx]?.[idx];
    if (Number.isFinite(candidate?.value)) return candidate;
  }
  return null;
}

function deltaFrom(cell, ref) {
  return Number.isFinite(cell?.value) && Number.isFinite(ref?.value) ? cell.value - ref.value : null;
}

function buildBASeries(points, columns) {
  const series = points.map((point, idx) => ({
    timestamp: point.timestamp,
    label: columns[idx]?.label || '',
    price: toNum(point.baPrice),
    y: null
  }));
  const prices = series.map((point) => point.price).filter(Number.isFinite);
  if (!prices.length) return series;
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min;
  return series.map((point) => ({
    ...point,
    y: Number.isFinite(point.price)
      ? (range > 0 ? (point.price - min) / range : 0.5)
      : null
  }));
}

export function buildIVDynamicsMatrix(history, config = {}) {
  const mode = config.mode === 'iv' ? 'iv' : 'premium';
  const maxColumns = Math.max(1, Math.floor(Number(config.maxColumns) || 120));
  const selected = (Array.isArray(history) ? history : []).filter(Boolean).slice(-maxColumns);
  const pointConfig = { ...config, mode };
  const points = selected.map((snapshot) => ({
    ...buildPoint(snapshot, pointConfig),
    baPrice: toNum(snapshot?.px)
  }));
  const rows = buildIVDynamicsRows(config.deltas);
  const columns = points.map((point, idx) => ({
    index: idx,
    timestamp: point.timestamp,
    expiration: point.expiration,
    baPrice: point.baPrice,
    label: (() => {
      const dt = new Date(point.timestamp || 0);
      return Number.isNaN(dt.getTime()) ? String(point.timestamp || '') : dt.toLocaleTimeString();
    })()
  }));
  const baSeries = buildBASeries(points, columns);
  const cells = rows.map((row, rowIdx) => points.map((point, colIdx) => {
    const base = point.rows.find((candidate) => candidate.key === row.key) || {
      ...row,
      timestamp: point.timestamp,
      expiration: point.expiration,
      iv: null,
      premium: null,
      value: null,
      atmIV: point.atmIV,
      atmStrike: point.atmStrike,
      matchedStrike: null,
      matchedDelta: null,
      warning: 'no row'
    };
    return {
      ...base,
      baPrice: point.baPrice,
      rowIdx,
      colIdx,
      comparisons: {}
    };
  }));

  for (let rowIdx = 0; rowIdx < rows.length; rowIdx += 1) {
    const sessionStart = cells[rowIdx].find((cell) => Number.isFinite(cell?.value)) || null;
    for (let colIdx = 0; colIdx < columns.length; colIdx += 1) {
      const cell = cells[rowIdx][colIdx];
      const previous = findPreviousCell(cells, rowIdx, colIdx);
      const timeMs = new Date(cell?.timestamp || 0).getTime();
      const m15 = findCellAtOrBefore(cells, columns.slice(0, colIdx), rowIdx, timeMs - 15 * 60 * 1000);
      const m60 = findCellAtOrBefore(cells, columns.slice(0, colIdx), rowIdx, timeMs - 60 * 60 * 1000);
      cell.comparisons = {
        previous: deltaFrom(cell, previous),
        m15: deltaFrom(cell, m15),
        m60: deltaFrom(cell, m60),
        session: deltaFrom(cell, sessionStart)
      };
    }
  }

  return {
    mode,
    showBA: Boolean(config.showBA),
    expiration: columns[columns.length - 1]?.expiration || normalizeExpiryKey(config.expiration),
    rows,
    columns,
    cells,
    warnings: Array.from(new Set(points.flatMap((point) => point.warnings || []))),
    baSeries
  };
}
