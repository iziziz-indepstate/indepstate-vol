const OPTION_TYPES = new Set(['put', 'call']);

function toNum(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeOptionType(value) {
  const normalized = String(value || '').toLowerCase();
  return OPTION_TYPES.has(normalized) ? normalized : 'put';
}

function normalizeTargetDelta(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0.25;
  return Math.min(0.99, Math.max(0.01, Math.abs(n)));
}

export function normalizeExpiryKey(value) {
  const raw = String(value || '').trim();
  if (/^\d{8}$/.test(raw)) return raw;
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10).replaceAll('-', '');
  return raw;
}

function quoteType(quote) {
  return String(quote?.type || quote?.optionType || quote?.['option-type'] || '').toLowerCase();
}

function isValidQuote(quote) {
  const bid = toNum(quote?.bid);
  const ask = toNum(quote?.ask);
  const iv = toNum(quote?.iv);
  const delta = toNum(quote?.delta);
  return Number.isFinite(iv)
    && iv > 0
    && Number.isFinite(bid)
    && Number.isFinite(ask)
    && bid >= 0
    && ask > 0
    && ask >= bid
    && Number.isFinite(delta);
}

function sideQuotes(expirySnapshot, optionType) {
  const type = normalizeOptionType(optionType);
  return (Array.isArray(expirySnapshot?.optionQuotes) ? expirySnapshot.optionQuotes : [])
    .filter((quote) => quoteType(quote) === type)
    .filter(isValidQuote)
    .map((quote) => ({
      ...quote,
      strike: toNum(quote.strike),
      delta: toNum(quote.delta),
      iv: toNum(quote.iv)
    }))
    .filter((quote) => Number.isFinite(quote.strike));
}

function deltaDistance(quote, optionType, targetDelta) {
  const delta = toNum(quote?.delta);
  if (!Number.isFinite(delta)) return Number.POSITIVE_INFINITY;
  if (normalizeOptionType(optionType) === 'put') return Math.abs(Math.abs(delta) - targetDelta);
  return Math.abs(delta - targetDelta);
}

export function selectNearestDeltaQuote(expirySnapshot, optionType, targetDelta) {
  const type = normalizeOptionType(optionType);
  const target = normalizeTargetDelta(targetDelta);
  const candidates = sideQuotes(expirySnapshot, type);
  if (!candidates.length) return null;

  return candidates.reduce((best, quote) => {
    if (!best) return quote;
    const currDistance = deltaDistance(quote, type, target);
    const bestDistance = deltaDistance(best, type, target);
    if (currDistance < bestDistance) return quote;
    if (currDistance > bestDistance) return best;
    return Math.abs(quote.strike) < Math.abs(best.strike) ? quote : best;
  }, null);
}

function groupValidQuotesByStrike(expirySnapshot) {
  const pairs = new Map();
  for (const quote of Array.isArray(expirySnapshot?.optionQuotes) ? expirySnapshot.optionQuotes : []) {
    if (!isValidQuote(quote)) continue;
    const strike = toNum(quote.strike);
    if (!Number.isFinite(strike)) continue;
    const type = quoteType(quote);
    if (!OPTION_TYPES.has(type)) continue;
    const key = String(strike);
    const row = pairs.get(key) || { strike, call: null, put: null };
    row[type] = {
      ...quote,
      strike,
      delta: toNum(quote.delta),
      iv: toNum(quote.iv)
    };
    pairs.set(key, row);
  }
  return Array.from(pairs.values()).sort((a, b) => a.strike - b.strike);
}

function avg(values) {
  const valid = values.filter(Number.isFinite);
  if (!valid.length) return null;
  return valid.reduce((acc, value) => acc + value, 0) / valid.length;
}

export function calculateAtmIV(expirySnapshot) {
  const pairs = groupValidQuotesByStrike(expirySnapshot);
  if (!pairs.length) return { atmStrike: null, atmIV: null };

  const reference = toNum(expirySnapshot?.px);
  let selected = null;
  if (Number.isFinite(reference)) {
    selected = pairs.reduce((best, pair) => {
      if (!best) return pair;
      return Math.abs(pair.strike - reference) < Math.abs(best.strike - reference) ? pair : best;
    }, null);
  } else {
    selected = pairs
      .filter((pair) => Number.isFinite(pair.call?.delta) || Number.isFinite(pair.put?.delta))
      .reduce((best, pair) => {
        const curr = Math.min(
          Number.isFinite(pair.call?.delta) ? Math.abs(pair.call.delta - 0.5) : Number.POSITIVE_INFINITY,
          Number.isFinite(pair.put?.delta) ? Math.abs(Math.abs(pair.put.delta) - 0.5) : Number.POSITIVE_INFINITY
        );
        if (!best) return { pair, distance: curr };
        return curr < best.distance ? { pair, distance: curr } : best;
      }, null)?.pair || null;
  }

  if (!selected) return { atmStrike: null, atmIV: null };
  return {
    atmStrike: selected.strike,
    atmIV: avg([toNum(selected.call?.iv), toNum(selected.put?.iv)])
  };
}

function findExpirySnapshot(snapshot, expiration) {
  let key = normalizeExpiryKey(expiration);
  if (snapshot?.byExpiry && typeof snapshot.byExpiry === 'object') {
    if (!key) key = normalizeExpiryKey(snapshot.expiry) || Object.keys(snapshot.byExpiry)[0] || '';
    if (snapshot.byExpiry[key]) return { key, snapshot: snapshot.byExpiry[key] };
    const found = Object.keys(snapshot.byExpiry).find((candidate) => normalizeExpiryKey(candidate) === key);
    if (found) return { key: found, snapshot: snapshot.byExpiry[found] };
    return { key, snapshot: null };
  }
  return { key: snapshot?.expiry || key, snapshot };
}

export function calculateNDeltaIVPoint(snapshot, config = {}) {
  const optionType = normalizeOptionType(config.optionType);
  const targetDelta = normalizeTargetDelta(config.targetDelta);
  const { key: expiration, snapshot: expirySnapshot } = findExpirySnapshot(snapshot, config.expiration);
  const timestamp = snapshot?.time || expirySnapshot?.time || null;

  if (!expirySnapshot) {
    return {
      timestamp,
      expiration,
      optionType,
      targetDelta,
      matchedStrike: null,
      matchedDelta: null,
      deltaIV: null,
      atmStrike: null,
      atmIV: null,
      deltaIVPremium: null,
      warning: 'no expiration match'
    };
  }

  const match = selectNearestDeltaQuote(expirySnapshot, optionType, targetDelta);
  const { atmStrike, atmIV } = calculateAtmIV(expirySnapshot);
  const deltaIV = toNum(match?.iv);
  const deltaIVPremium = Number.isFinite(deltaIV) && Number.isFinite(atmIV) ? deltaIV - atmIV : null;

  return {
    timestamp,
    expiration,
    optionType,
    targetDelta,
    matchedStrike: toNum(match?.strike),
    matchedDelta: toNum(match?.delta),
    deltaIV,
    atmStrike,
    atmIV,
    deltaIVPremium,
    warning: match ? null : 'no delta match'
  };
}

export function buildNDeltaIVSeries(history, config = {}) {
  return (Array.isArray(history) ? history : [])
    .map((snapshot) => calculateNDeltaIVPoint(snapshot, config));
}
