const marketDate = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
});

function number(value) {
  if (value == null || String(value).trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function normalizeSkewDelta(value) {
  return Math.min(0.49, Math.max(0.01, Math.abs(number(value) ?? 0.25)));
}

export function skewSessionDate(timestamp) {
  const date = new Date(timestamp ?? '');
  if (!Number.isFinite(date.getTime())) return '';
  const parts = Object.fromEntries(marketDate.formatToParts(date).map(({ type, value }) => [type, value]));
  return `${parts.year}${parts.month}${parts.day}`;
}

export function resolveSkewExpiration(snapshot, expiration = 'today') {
  const token = String(expiration || 'today').trim();
  return token.toLowerCase() === 'today'
    ? skewSessionDate(snapshot?.time)
    : token.replaceAll('-', '');
}

export function readSkewQuotes(snapshot) {
  return (Array.isArray(snapshot?.optionQuotes) ? snapshot.optionQuotes : []).map((q) => ({
    type: String(q?.type || q?.optionType || '').toLowerCase(),
    strike: number(q?.strike), delta: number(q?.delta), iv: number(q?.iv),
    bid: number(q?.bid), ask: number(q?.ask)
  }));
}

export function isValidSkewQuote(q) {
  return (q.type === 'put' || q.type === 'call')
    && q.strike != null && q.delta != null && q.iv > 0
    && q.bid != null && q.bid >= 0 && q.ask > 0 && q.ask >= q.bid;
}

function deltaCandidates(quotes, side, px) {
  if (px == null) return [];
  return quotes.filter((q) => q.type === side
    && (side === 'put' ? q.strike < px && q.delta < 0 : q.strike > px && q.delta > 0))
    .sort((a, b) => Math.abs(a.delta) - Math.abs(b.delta) || a.strike - b.strike);
}

function interpolate(candidates, target) {
  const exact = candidates.find((q) => Math.abs(Math.abs(q.delta) - target) < 1e-10);
  if (exact) return { iv: exact.iv, strike: exact.strike, contracts: [exact] };
  const lower = candidates.findLast((q) => Math.abs(q.delta) < target);
  const upper = candidates.find((q) => Math.abs(q.delta) > target);
  if (!lower || !upper) return { iv: null, strike: null, contracts: [] };
  const weight = (target - Math.abs(lower.delta)) / (Math.abs(upper.delta) - Math.abs(lower.delta));
  return {
    iv: lower.iv + weight * (upper.iv - lower.iv),
    strike: lower.strike + weight * (upper.strike - lower.strike),
    contracts: [lower, upper]
  };
}

export function skewSpot(expirySnapshot, snapshot) {
  return number(expirySnapshot?.px) ?? number(snapshot?.px);
}

export function analyzeSkewQuotes(quotes, px, targets) {
  const valid = quotes.filter(isValidSkewQuote);
  const puts = new Map(valid.filter((q) => q.type === 'put').map((q) => [q.strike, q]));
  const atm = px == null ? null : valid.filter((q) => q.type === 'call' && puts.has(q.strike))
    .sort((a, b) => Math.abs(a.strike - px) - Math.abs(b.strike - px) || a.strike - b.strike)[0];
  const otmPuts = deltaCandidates(valid, 'put', px);
  const otmCalls = deltaCandidates(valid, 'call', px);
  return {
    atmStrike: atm?.strike ?? null,
    atmIV: atm ? (atm.iv + puts.get(atm.strike).iv) / 2 : null,
    wings: targets.map((target) => ({
      put: interpolate(otmPuts, target),
      call: interpolate(otmCalls, target)
    }))
  };
}

export function calculateZeroDteSkewPoint(snapshot, config = {}) {
  const timestamp = snapshot?.time ?? null;
  const expiration = resolveSkewExpiration(snapshot, config.expiration);
  const expirySnapshot = expiration ? (snapshot?.byExpiry?.[expiration]
    ?? (String(snapshot?.expiry || '').replaceAll('-', '') === expiration ? snapshot : null)) : null;
  const targetDelta = normalizeSkewDelta(config.targetDelta);
  const { atmStrike, atmIV, wings: [wing] } = analyzeSkewQuotes(
    readSkewQuotes(expirySnapshot), skewSpot(expirySnapshot, snapshot), [targetDelta]
  );
  const put = { iv: wing.put.iv, contracts: wing.put.contracts };
  const call = { iv: wing.call.iv, contracts: wing.call.contracts };
  return {
    timestamp, expiration, sessionDate: skewSessionDate(timestamp), targetDelta,
    atmStrike, atmIV, put, call,
    skew: put.iv != null && call.iv != null ? put.iv - call.iv : null,
    putWing: put.iv != null && atmIV != null ? put.iv - atmIV : null,
    callWing: call.iv != null && atmIV != null ? call.iv - atmIV : null,
    warning: !expirySnapshot ? `No chain for expiration ${expiration || 'unknown'}`
      : [atmStrike == null && 'No valid ATM pair', put.iv == null && 'No put delta bracket', call.iv == null && 'No call delta bracket'].filter(Boolean).join('; ')
  };
}

export function buildZeroDteSkewSeries(history, config = {}) {
  return (Array.isArray(history) ? history : []).map((snapshot) => calculateZeroDteSkewPoint(snapshot, config));
}
