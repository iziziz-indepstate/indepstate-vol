import { normalizeStrikeConfig } from './option-chain-utils.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_STALE_MS = 15 * 60 * 1000;

function toNum(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function avg(values) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : undefined;
}

function sumIfFinite(a, b) {
  return Number.isFinite(a) && Number.isFinite(b) ? a + b : undefined;
}

function parseDateLike(value, marketClose = false) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^\d{8}$/.test(raw)) {
    const y = Number(raw.slice(0, 4));
    const m = Number(raw.slice(4, 6));
    const d = Number(raw.slice(6, 8));
    return new Date(Date.UTC(y, m - 1, d, marketClose ? 21 : 0, 0, 0));
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const [y, m, d] = raw.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d, marketClose ? 21 : 0, 0, 0));
  }
  const dt = new Date(raw);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function formatExpiry(value) {
  const raw = String(value || '').trim();
  if (/^\d{8}$/.test(raw)) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  const dt = parseDateLike(raw, true);
  if (!dt) return raw;
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

function expiryKeyMatches(key, override) {
  return formatExpiry(key) === formatExpiry(override) || String(key) === String(override);
}

export function parseTenorToDte(tenor) {
  const raw = String(tenor || '').trim().toUpperCase();
  const match = raw.match(/^(\d+)(DTE|D|W|M)$/);
  if (!match) throw new Error(`Invalid tenor "${tenor}". Use values like 0DTE, 1D, 1W, 2W, 1M.`);
  const value = Number(match[1]);
  const unit = match[2];
  if (unit === 'DTE' || unit === 'D') return value;
  if (unit === 'W') return value * 7;
  return value * 30;
}

function hasValidBidAskPair(expirySnapshot) {
  const quotes = Array.isArray(expirySnapshot?.optionQuotes) ? expirySnapshot.optionQuotes : [];
  const byStrike = new Map();
  for (const raw of quotes) {
    const strike = toNum(raw?.strike);
    const type = String(raw?.type || raw?.optionType || '').toLowerCase();
    if (!Number.isFinite(strike) || (type !== 'call' && type !== 'put')) continue;

    const bid = toNum(raw?.bid);
    const ask = toNum(raw?.ask);
    const mid = bid != null && ask != null && ask >= bid ? (bid + ask) / 2 : toNum(raw?.mid ?? raw?.mark ?? raw?.theoPrice);
    if (bid == null || ask == null || bid < 0 || ask < 0 || ask < bid || !(mid > 0)) continue;

    const row = byStrike.get(strike) || {};
    row[type] = true;
    byStrike.set(strike, row);
  }

  return Array.from(byStrike.values()).some((pair) => pair.call && pair.put);
}

export function selectExpiry(snapshot, params = {}) {
  const byExpiry = snapshot?.byExpiry && typeof snapshot.byExpiry === 'object' ? snapshot.byExpiry : null;
  const entries = byExpiry
    ? Object.entries(byExpiry)
    : (snapshot?.expiry ? [[snapshot.expiry, snapshot]] : []);
  if (!entries.length) throw new Error(`No ${params.symbol || 'SPX'} expiry found for tenor ${params.tenor || '1W'}.`);

  const snapshotTime = parseDateLike(params.snapshotTime || snapshot?.time || new Date().toISOString());
  if (!snapshotTime) throw new Error('Missing snapshot timestamp.');

  if (params.expiryOverride) {
    const found = entries.find(([expiry]) => expiryKeyMatches(expiry, params.expiryOverride));
    if (!found) throw new Error(`No ${params.symbol || 'SPX'} expiry found for override ${params.expiryOverride}.`);
    const expiryTime = parseDateLike(found[0], true);
    return {
      key: found[0],
      snapshot: found[1],
      expiry: formatExpiry(found[0]),
      dte: expiryTime ? (expiryTime.getTime() - snapshotTime.getTime()) / MS_PER_DAY : 0,
      selectionMode: 'override'
    };
  }

  const targetDte = parseTenorToDte(params.tenor || '1W');
  const rows = entries
    .map(([key, snap]) => {
      const expiryTime = parseDateLike(key, true);
      return expiryTime ? {
        key,
        snapshot: snap,
        expiry: formatExpiry(key),
        dte: (expiryTime.getTime() - snapshotTime.getTime()) / MS_PER_DAY
      } : null;
    })
    .filter((row) => row && hasValidBidAskPair(row.snapshot))
    .sort((a, b) => a.dte - b.dte);

  if (!rows.length) throw new Error(`No ${params.symbol || 'SPX'} expiry with valid call/put quotes found for tenor ${params.tenor || '1W'}.`);

  const mode = params.expirySelectionMode || 'nearest';
  if (mode === 'at_or_after') {
    const found = rows.find((row) => row.dte >= targetDte);
    if (!found) throw new Error(`No ${params.symbol || 'SPX'} expiry found at or after tenor ${params.tenor || '1W'}.`);
    return { ...found, selectionMode: mode };
  }
  if (mode === 'at_or_before') {
    const found = [...rows].reverse().find((row) => row.dte <= targetDte);
    if (!found) throw new Error(`No ${params.symbol || 'SPX'} expiry found at or before tenor ${params.tenor || '1W'}.`);
    return { ...found, selectionMode: mode };
  }

  const found = rows.reduce((best, row) => {
    if (!best) return row;
    const bestDist = Math.abs(best.dte - targetDte);
    const rowDist = Math.abs(row.dte - targetDte);
    if (rowDist < bestDist) return row;
    if (rowDist === bestDist && row.dte > best.dte) return row;
    return best;
  }, null);
  return { ...found, selectionMode: mode };
}

function quoteMid(quote, quoteMode) {
  const bid = toNum(quote?.bid);
  const ask = toNum(quote?.ask);
  if (bid != null && ask != null && ask >= bid) return (bid + ask) / 2;
  if (quoteMode === 'mark') return toNum(quote?.mark ?? quote?.theoPrice ?? quote?.mid);
  return toNum(quote?.mid);
}

function normalizeQuote(quote, quoteMode) {
  const bid = toNum(quote?.bid);
  const ask = toNum(quote?.ask);
  const mid = quoteMid(quote, quoteMode);
  return {
    bid,
    ask,
    mid,
    iv: toNum(quote?.iv),
    delta: toNum(quote?.delta),
    gamma: toNum(quote?.gamma),
    vega: toNum(quote?.vega),
    theta: toNum(quote?.theta),
    timestamp: quote?.timestamp || quote?.time || null
  };
}

export function validateQuote(quote, snapshotTime, quoteMode = 'mid', staleMs = DEFAULT_STALE_MS) {
  const flags = [];
  const q = normalizeQuote(quote, quoteMode);
  if (q.bid == null || q.ask == null) flags.push('MISSING_BID_ASK');
  if ((q.bid != null && q.bid < 0) || (q.ask != null && q.ask < 0) || (q.bid != null && q.ask != null && q.ask < q.bid) || !(q.mid > 0)) {
    flags.push('NEGATIVE_OR_INVALID_QUOTE');
  }
  const quoteTime = parseDateLike(q.timestamp);
  const snapTime = parseDateLike(snapshotTime);
  if (quoteTime && snapTime && snapTime.getTime() - quoteTime.getTime() > staleMs) flags.push('STALE_QUOTE');
  return { quote: q, flags, valid: !flags.includes('NEGATIVE_OR_INVALID_QUOTE') && q.mid > 0 };
}

function pairQualityScore(call, put, snapshotTime, quoteMode) {
  const cv = validateQuote(call, snapshotTime, quoteMode);
  const pv = validateQuote(put, snapshotTime, quoteMode);
  const callSpread = cv.quote.ask != null && cv.quote.bid != null ? cv.quote.ask - cv.quote.bid : Number.POSITIVE_INFINITY;
  const putSpread = pv.quote.ask != null && pv.quote.bid != null ? pv.quote.ask - pv.quote.bid : Number.POSITIVE_INFINITY;
  const penalties = cv.flags.length + pv.flags.length;
  return penalties * 1000000 + callSpread + putSpread;
}

export function selectAtmPair(expirySnapshot, referencePrice, snapshotTime, quoteMode = 'mid', atmStrikeOverride = null) {
  const quotes = Array.isArray(expirySnapshot?.optionQuotes) ? expirySnapshot.optionQuotes : [];
  const byStrike = new Map();
  for (const raw of quotes) {
    const strike = toNum(raw?.strike);
    const type = String(raw?.type || raw?.optionType || '').toLowerCase();
    if (!Number.isFinite(strike) || (type !== 'call' && type !== 'put')) continue;
    const row = byStrike.get(strike) || {};
    row[type] = raw;
    byStrike.set(strike, row);
  }

  const pairs = Array.from(byStrike.entries())
    .map(([strike, pair]) => ({ strike, call: pair.call, put: pair.put }))
    .filter((pair) => pair.call && pair.put)
    .filter((pair) => validateQuote(pair.call, snapshotTime, quoteMode).valid && validateQuote(pair.put, snapshotTime, quoteMode).valid);

  if (!pairs.length) throw new Error('No valid call/put pair found near reference price for selected expiry.');

  const override = normalizeStrikeConfig(atmStrikeOverride);
  if (override.kind === 'numeric') {
    const found = pairs.find((pair) => pair.strike === override.value);
    if (!found) throw new Error(`No valid call/put pair found for ATM strike ${override.value}.`);
    return { ...found, atmSelectionMethod: 'manual_strike' };
  }

  if (Number.isFinite(referencePrice)) {
    const found = pairs.reduce((best, pair) => {
      if (!best) return pair;
      const bestDist = Math.abs(best.strike - referencePrice);
      const pairDist = Math.abs(pair.strike - referencePrice);
      if (pairDist < bestDist) return pair;
      if (pairDist === bestDist && pairQualityScore(pair.call, pair.put, snapshotTime, quoteMode) < pairQualityScore(best.call, best.put, snapshotTime, quoteMode)) return pair;
      return best;
    }, null);
    return { ...found, atmSelectionMethod: override.kind === 'atm' ? 'explicit_atm' : 'nearest_to_reference' };
  }

  const deltaPairs = pairs.filter((pair) => Number.isFinite(toNum(pair.call?.delta)) && Number.isFinite(toNum(pair.put?.delta)));
  if (!deltaPairs.length) throw new Error('Missing reference price. Provide manualReferencePrice or check datasource.');
  const found = deltaPairs.reduce((best, pair) => {
    if (!best) return pair;
    return Math.abs(toNum(pair.call.delta) + toNum(pair.put.delta)) < Math.abs(toNum(best.call.delta) + toNum(best.put.delta)) ? pair : best;
  }, null);
  return { ...found, atmSelectionMethod: 'delta_neutral_fallback' };
}

function referencePrice(snapshot, params) {
  if (params.referencePriceMode === 'manual') {
    const manual = toNum(params.manualReferencePrice);
    if (!Number.isFinite(manual)) throw new Error('Missing reference price. Provide manualReferencePrice or check datasource.');
    return { value: manual, source: 'manual' };
  }
  if (params.referencePriceMode === 'forward') {
    const fwd = toNum(snapshot?.forward ?? snapshot?.referenceForward ?? snapshot?.forwardPrice);
    if (Number.isFinite(fwd)) return { value: fwd, source: 'forward' };
  }
  const spot = toNum(snapshot?.px ?? snapshot?.spot ?? snapshot?.underlyingPrice ?? snapshot?.referencePrice);
  if (!Number.isFinite(spot)) throw new Error('Missing reference price. Provide manualReferencePrice or check datasource.');
  return { value: spot, source: 'spot' };
}

function qualityFlags(call, put, straddle, snapshotTime, quoteMode) {
  const flags = new Set([
    ...validateQuote(call, snapshotTime, quoteMode).flags,
    ...validateQuote(put, snapshotTime, quoteMode).flags
  ]);
  if (Number.isFinite(straddle.spreadPct)) {
    if (straddle.spreadPct > 0.05) flags.add('WIDE_SPREAD');
    if (straddle.spreadPct > 0.10) flags.add('LOW_CONFIDENCE');
  }
  if (flags.has('STALE_QUOTE')) flags.add('LOW_CONFIDENCE');
  if (!flags.size) flags.add('OK');
  return Array.from(flags);
}

function computeFromSnapshot(snapshot, params = {}) {
  const symbol = params.symbol || 'SPX';
  const tenor = params.tenor || '1W';
  const quoteMode = params.quoteMode || 'mid';
  const selected = selectExpiry(snapshot, { ...params, symbol, tenor });
  const snap = selected.snapshot;
  const ref = referencePrice(snap, params);
  const pair = selectAtmPair(
    snap,
    ref.value,
    params.snapshotTime || snap?.time || snapshot?.time,
    quoteMode,
    params.atmStrikeOverride
  );
  const call = normalizeQuote(pair.call, quoteMode);
  const put = normalizeQuote(pair.put, quoteMode);
  const straddleBid = call.bid + put.bid;
  const straddleMid = call.mid + put.mid;
  const straddleAsk = call.ask + put.ask;
  const spreadPts = straddleAsk - straddleBid;
  const spreadPct = spreadPts / straddleMid;
  const atmIv = avg([call.iv, put.iv]);
  const callPutIvSpread = Number.isFinite(call.iv) && Number.isFinite(put.iv) ? put.iv - call.iv : undefined;
  const snapshotTime = params.snapshotTime || snap?.time || snapshot?.time;
  const straddle = {
    bid: straddleBid,
    mid: straddleMid,
    ask: straddleAsk,
    spreadPts,
    spreadPct,
    impliedMovePts: straddleMid,
    impliedMovePct: straddleMid / ref.value,
    expectedLow: ref.value - straddleMid,
    expectedHigh: ref.value + straddleMid
  };

  return {
    symbol,
    tenor,
    expiry: selected.expiry,
    dte: selected.dte,
    expirySelectionMode: selected.selectionMode,
    referencePrice: ref.value,
    referencePriceSource: ref.source,
    atmStrike: pair.strike,
    atmSelectionMethod: pair.atmSelectionMethod,
    call,
    put,
    straddle,
    atmIv,
    callPutIvSpread,
    netGreeks: {
      delta: sumIfFinite(call.delta, put.delta),
      gamma: sumIfFinite(call.gamma, put.gamma),
      vega: sumIfFinite(call.vega, put.vega),
      theta: sumIfFinite(call.theta, put.theta)
    },
    qualityFlags: qualityFlags(pair.call, pair.put, straddle, snapshotTime, quoteMode)
  };
}

function applyComparison(current, previous, mode) {
  if (!previous) return current;
  current.comparison = {
    mode,
    deltaStraddlePts: current.straddle.mid - previous.straddle.mid,
    deltaStraddlePct: (current.straddle.mid - previous.straddle.mid) / previous.straddle.mid,
    deltaAtmIv: Number.isFinite(current.atmIv) && Number.isFinite(previous.atmIv) ? current.atmIv - previous.atmIv : undefined,
    deltaImpliedMovePct: current.straddle.impliedMovePct - previous.straddle.impliedMovePct,
    deltaUnderlying: current.referencePrice - previous.referencePrice
  };
  return current;
}

function stateLabels(snapshot) {
  const labels = [];
  const c = snapshot.comparison;
  if (c) {
    if (c.deltaUnderlying > 0 && c.deltaAtmIv > 0) labels.push('SPOT_UP_VOL_UP');
    if (c.deltaUnderlying < 0 && c.deltaAtmIv < 0) labels.push('SPOT_DOWN_VOL_DOWN');
    if (c.deltaStraddlePct < -0.05 && c.deltaAtmIv < 0) labels.push('VOL_CRUSH');
    if (c.deltaStraddlePct >= 0 || c.deltaAtmIv >= 0) labels.push('MOVEMENT_BID');
  }
  if (!labels.length) labels.push('MOVEMENT_BID');
  if (snapshot.qualityFlags.includes('WIDE_SPREAD') || snapshot.qualityFlags.includes('STALE_QUOTE') || !c) labels.push('LOW_CONFIDENCE');
  return Array.from(new Set(labels));
}

export async function calculateAtmStraddle(params = {}) {
  const snapshot = params.snapshot || params.currentSnapshot;
  if (!snapshot) throw new Error('No option-chain snapshot available.');
  const current = computeFromSnapshot(snapshot, params);
  const compareTo = params.compareTo || 'previous_close';
  if (compareTo !== 'none' && (params.comparisonSnapshot || params.previousSnapshot)) {
    try {
      const previous = computeFromSnapshot(params.comparisonSnapshot || params.previousSnapshot, params);
      applyComparison(current, previous, compareTo);
    } catch {
      current.comparison = undefined;
    }
  }
  current.stateLabels = stateLabels(current);
  return current;
}
