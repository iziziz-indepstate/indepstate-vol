import { selectAtmPair, selectExpiry } from './atm-straddle-calculations.mjs';
import { findStrikesAroundPrice, resolveConfiguredStrike, resolveStrikeSelection } from './option-chain-utils.js';

export const SNAPSHOT_TRIM_VERSION = 1;

const MIN_QUOTE_FIELDS = [
  'type',
  'optionType',
  'strike',
  'bid',
  'ask',
  'mid',
  'iv',
  'delta',
  'gamma',
  'theta',
  'vega',
  'timestamp',
  'time'
];

const DEFAULT_SR_PATTERN = [5, 5, 5, 10];
const DEFAULT_SR_POINTS = 10;

function toNum(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeExpiryKey(value) {
  const raw = String(value || '').trim();
  if (/^\d{8}$/.test(raw)) return raw;
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10).replaceAll('-', '');
  return raw;
}

function quoteType(quote) {
  return String(quote?.type || quote?.optionType || '').toLowerCase();
}

function quoteKey(type, strike) {
  return `${String(type || '').toLowerCase()}:${Number(strike)}`;
}

function compactQuote(quote) {
  const out = {};
  for (const field of MIN_QUOTE_FIELDS) {
    if (quote?.[field] !== undefined) out[field] = quote[field];
  }
  if (!out.type && out.optionType) out.type = out.optionType;
  delete out.optionType;
  return out;
}

function expiryEntries(snapshot) {
  if (snapshot?.byExpiry && typeof snapshot.byExpiry === 'object') {
    return Object.entries(snapshot.byExpiry);
  }
  if (snapshot?.expiry) return [[snapshot.expiry, snapshot]];
  return [];
}

function primaryExpiryKey(snapshot) {
  const explicit = normalizeExpiryKey(snapshot?.expiry);
  if (explicit) return explicit;
  return normalizeExpiryKey(expiryEntries(snapshot)[0]?.[0]);
}

function findExpiryEntry(snapshot, expiry) {
  const wanted = normalizeExpiryKey(expiry);
  return expiryEntries(snapshot).find(([key]) => normalizeExpiryKey(key) === wanted) || null;
}

function addNeed(needs, expiry, options = {}) {
  const key = normalizeExpiryKey(expiry);
  if (!key) return null;
  const need = needs.get(key) || { allQuotes: false, quoteKeys: new Set(), strikes: new Set() };
  if (options.allQuotes) need.allQuotes = true;
  for (const strike of options.strikes || []) {
    const parsed = toNum(strike);
    if (Number.isFinite(parsed)) need.strikes.add(parsed);
  }
  for (const quote of options.quotes || []) {
    const strike = toNum(quote?.strike);
    const type = quoteType(quote);
    if (Number.isFinite(strike) && (type === 'put' || type === 'call')) {
      need.quoteKeys.add(quoteKey(type, strike));
      need.strikes.add(strike);
    }
  }
  needs.set(key, need);
  return need;
}

function addStrikeNeed(needs, expiry, strike, sides = ['put', 'call']) {
  const parsed = toNum(strike);
  if (!Number.isFinite(parsed)) return;
  const quotes = sides.map((side) => ({ type: side, strike: parsed }));
  addNeed(needs, expiry, { strikes: [parsed], quotes });
}

function parseDateKey(value) {
  const key = normalizeExpiryKey(value);
  if (!/^\d{8}$/.test(key)) return null;
  const y = Number(key.slice(0, 4));
  const m = Number(key.slice(4, 6));
  const d = Number(key.slice(6, 8));
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt;
}

function expiryKeysInRange(snapshot, startRaw, endRaw) {
  const entries = expiryEntries(snapshot);
  const start = normalizeExpiryKey(startRaw);
  const end = normalizeExpiryKey(endRaw || startRaw);
  if (!start) return entries.map(([key]) => normalizeExpiryKey(key)).filter(Boolean);
  return entries
    .map(([key]) => normalizeExpiryKey(key))
    .filter((key) => key && key >= start && key <= (end || start));
}

function normalizeStrikeRangeConfig(raw) {
  if (raw == null || raw === '') return { mode: 'pattern', pattern: DEFAULT_SR_PATTERN };
  if (typeof raw === 'number' && Number.isFinite(raw)) return { mode: 'count', count: Math.max(1, Math.floor(raw)) };
  if (Array.isArray(raw)) {
    const pattern = raw.map(Number).filter((x) => Number.isFinite(x) && x > 0);
    return pattern.length ? { mode: 'pattern', pattern } : { mode: 'pattern', pattern: DEFAULT_SR_PATTERN };
  }
  const text = String(raw).trim();
  if (!text) return { mode: 'pattern', pattern: DEFAULT_SR_PATTERN };
  const numeric = Number(text);
  if (Number.isFinite(numeric)) return { mode: 'count', count: Math.max(1, Math.floor(numeric)) };
  if (text.startsWith('[') && text.endsWith(']')) {
    try {
      return normalizeStrikeRangeConfig(JSON.parse(text));
    } catch {
      return { mode: 'pattern', pattern: DEFAULT_SR_PATTERN };
    }
  }
  return { mode: 'pattern', pattern: DEFAULT_SR_PATTERN };
}

function inferBaseStep(strikesAsc, anchorIdx) {
  const diffs = [];
  const from = Math.max(1, anchorIdx - 4);
  const to = Math.min(strikesAsc.length - 1, anchorIdx + 4);
  for (let i = from; i <= to; i += 1) {
    const diff = Math.abs(strikesAsc[i] - strikesAsc[i - 1]);
    if (Number.isFinite(diff) && diff > 0) diffs.push(diff);
  }
  return diffs.length ? Math.min(...diffs) : 5;
}

function pickNDateStrikes(strikesAsc, baseStrike, direction, strikeRange) {
  if (!Array.isArray(strikesAsc) || !strikesAsc.length || !Number.isFinite(baseStrike)) return [];
  let anchorIdx = strikesAsc.findIndex((strike) => strike === baseStrike);
  if (anchorIdx === -1 && direction === 'up') anchorIdx = strikesAsc.findIndex((strike) => strike >= baseStrike);
  if (anchorIdx === -1 && direction === 'down') {
    for (let i = strikesAsc.length - 1; i >= 0; i -= 1) {
      if (strikesAsc[i] <= baseStrike) {
        anchorIdx = i;
        break;
      }
    }
  }
  if (anchorIdx === -1) anchorIdx = direction === 'up' ? strikesAsc.length - 1 : 0;

  const normalized = normalizeStrikeRangeConfig(strikeRange);
  if (normalized.mode === 'count') {
    const out = [];
    for (let i = 1; i <= normalized.count; i += 1) {
      const strike = strikesAsc[direction === 'up' ? anchorIdx + i : anchorIdx - i];
      if (Number.isFinite(strike)) out.push(strike);
    }
    return out;
  }

  const step = inferBaseStep(strikesAsc, anchorIdx);
  const anchor = strikesAsc[anchorIdx] ?? baseStrike;
  const out = [];
  const used = new Set();
  let acc = 0;
  for (let i = 0; i < DEFAULT_SR_POINTS; i += 1) {
    const part = normalized.pattern[i % normalized.pattern.length];
    acc += part;
    const target = direction === 'up' ? anchor + (step * acc) : anchor - (step * acc);
    const strike = direction === 'up'
      ? strikesAsc.find((candidate) => candidate >= target)
      : [...strikesAsc].reverse().find((candidate) => candidate <= target);
    if (!Number.isFinite(strike) || used.has(strike)) continue;
    used.add(strike);
    out.push(strike);
  }
  return out;
}

function strikesFromSnapshot(expirySnapshot, side) {
  const key = side === 'call' ? 'callStrikesAsc' : 'putStrikesAsc';
  if (Array.isArray(expirySnapshot?.[key])) return expirySnapshot[key].filter(Number.isFinite);
  return (Array.isArray(expirySnapshot?.optionQuotes) ? expirySnapshot.optionQuotes : [])
    .filter((quote) => quoteType(quote) === side)
    .map((quote) => toNum(quote?.strike))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
}

function addNDateNeed(snapshot, needs, widget) {
  const type = String(widget?.type || '');
  const side = type.includes('-call-') ? 'call' : 'put';
  const direction = side === 'call' ? 'up' : 'down';
  const cfg = widget?.config || {};
  const expiries = expiryKeysInRange(snapshot, cfg.expiryStart, cfg.expiryEnd);
  for (const expiry of expiries) {
    const entry = findExpiryEntry(snapshot, expiry);
    const snap = entry?.[1];
    if (!snap) continue;
    const strikesAsc = strikesFromSnapshot(snap, side);
    const { strike: baseStrike } = resolveConfiguredStrike(strikesAsc, cfg.baseStrike, {
      snapshot: snap,
      defaultStrike: 500
    });
    addStrikeNeed(needs, expiry, baseStrike, [side]);
    for (const strike of pickNDateStrikes(strikesAsc, baseStrike, direction, cfg.strikeRange)) {
      addStrikeNeed(needs, expiry, strike, [side]);
    }
  }
}

function addBidIvRatioNeed(snapshot, needs, widget) {
  const cfg = widget?.config || {};
  const expiries = expiryKeysInRange(snapshot, cfg.expiryStart, cfg.expiryEnd);
  for (const expiry of expiries) {
    const entry = findExpiryEntry(snapshot, expiry);
    const snap = entry?.[1];
    if (!snap) continue;
    const putStrikes = strikesFromSnapshot(snap, 'put');
    const callStrikes = strikesFromSnapshot(snap, 'call');
    const strikesAsc = Array.from(new Set([...putStrikes, ...callStrikes])).sort((a, b) => a - b);
    const configured = String(cfg.baseStrike ?? '').trim();
    const reference = configured.toUpperCase() === 'ATM'
      ? resolveConfiguredStrike(strikesAsc, configured, { snapshot: snap }).strike
      : (toNum(snap?.forward ?? snap?.fwd ?? snap?.F ?? snap?.f)
        ?? resolveConfiguredStrike(strikesAsc, configured, { defaultStrike: null }).strike
        ?? toNum(snap?.px));
    if (!Number.isFinite(reference)) continue;
    const lower = [...putStrikes].reverse().filter((strike) => strike < reference);
    const upper = callStrikes.filter((strike) => strike > reference);
    const selected = Math.max(1, normalizeStrikeRangeConfig(cfg.strikeRange).count || DEFAULT_SR_POINTS);
    const pairs = Math.min(selected, lower.length, upper.length);
    for (let i = 0; i < pairs; i += 1) {
      addStrikeNeed(needs, expiry, lower[i], ['put']);
      addStrikeNeed(needs, expiry, upper[i], ['call']);
    }
    const center = strikesAsc.reduce((best, strike) => {
      if (!Number.isFinite(best)) return strike;
      return Math.abs(strike - reference) < Math.abs(best - reference) ? strike : best;
    }, Number.NaN);
    addStrikeNeed(needs, expiry, center, ['put', 'call']);
  }
}

function addNDeltaNeed(snapshot, needs, widget) {
  const expiry = normalizeExpiryKey(widget?.config?.expiration) || primaryExpiryKey(snapshot);
  if (expiry) addNeed(needs, expiry, { allQuotes: true });
}

function addStraddleNeed(snapshot, needs, widget) {
  const cfg = widget?.config || {};
  try {
    const selected = selectExpiry(snapshot, {
      ...cfg,
      expiryOverride: cfg.expiryOverride || undefined,
      snapshotTime: snapshot?.time,
      symbol: cfg.symbol || 'SPX',
      tenor: cfg.tenor || '1W'
    });
    const snap = selected?.snapshot;
    const reference = toNum(cfg.manualReferencePrice) ?? toNum(snap?.px ?? snapshot?.px);
    const pair = selectAtmPair(snap, reference, snapshot?.time || snap?.time, cfg.quoteMode || 'mid', cfg.atmStrikeOverride);
    addNeed(needs, selected.key, { quotes: [pair.call, pair.put] });
  } catch {
    const fallback = primaryExpiryKey(snapshot);
    if (fallback) addNeed(needs, fallback, { allQuotes: true });
  }
}

function addSpreadOptimizerNeed(snapshot, needs, widget) {
  const cfg = widget?.config || {};
  const expiry = normalizeExpiryKey(cfg.expiry) || primaryExpiryKey(snapshot);
  const entry = findExpiryEntry(snapshot, expiry);
  const snap = entry?.[1];
  if (!snap) return;
  const spot = toNum(snapshot?.px ?? snap?.px);
  const min = toNum(cfg.strikeMin) ?? (Number.isFinite(spot) ? spot * 0.9 : Number.NEGATIVE_INFINITY);
  const max = toNum(cfg.strikeMax) ?? (Number.isFinite(spot) ? spot * 1.1 : Number.POSITIVE_INFINITY);
  const quotes = (Array.isArray(snap.optionQuotes) ? snap.optionQuotes : [])
    .filter((quote) => {
      const strike = toNum(quote?.strike);
      return Number.isFinite(strike) && strike >= min && strike <= max;
    });
  addNeed(needs, expiry, { quotes });
}

function addIvCurrentNeed(snapshot, needs, widget) {
  const expiry = primaryExpiryKey(snapshot);
  const entry = findExpiryEntry(snapshot, expiry);
  const snap = entry?.[1];
  if (!snap) return;
  const strikesAsc = Array.from(new Set([...strikesFromSnapshot(snap, 'put'), ...strikesFromSnapshot(snap, 'call')])).sort((a, b) => a - b);
  const { strike } = resolveStrikeSelection(strikesAsc, widget?.config?.baseStrike, snap?.px ?? snapshot?.px);
  addStrikeNeed(needs, expiry, strike, ['put', 'call']);
}

function addTailSkewNeed(snapshot, needs, widget) {
  const expiry = primaryExpiryKey(snapshot);
  const entry = findExpiryEntry(snapshot, expiry);
  const snap = entry?.[1];
  if (!snap) return;
  const tailSteps = Math.max(1, Number(widget?.config?.tailSteps) || 3);
  const strikesAsc = Array.from(new Set([...strikesFromSnapshot(snap, 'put'), ...strikesFromSnapshot(snap, 'call')])).sort((a, b) => a - b);
  const { lowerIdx, upperIdx } = findStrikesAroundPrice(strikesAsc, snap?.px ?? snapshot?.px);
  addStrikeNeed(needs, expiry, strikesAsc[lowerIdx - tailSteps], ['put']);
  addStrikeNeed(needs, expiry, strikesAsc[upperIdx + tailSteps], ['call']);
}

function collectNeeds(snapshot, tab) {
  const needs = new Map();
  for (const widget of tab?.widgets || []) {
    const type = String(widget?.type || '');
    if (type === 'n-delta-iv') addNDeltaNeed(snapshot, needs, widget);
    else if (type === 'atm-straddle') addStraddleNeed(snapshot, needs, widget);
    else if (type === 'spread-optimizer') addSpreadOptimizerNeed(snapshot, needs, widget);
    else if (type === 'iv-current-line') addIvCurrentNeed(snapshot, needs, widget);
    else if (type === 'tail-skew-line') addTailSkewNeed(snapshot, needs, widget);
    else if (type === 'ndate-skew-bidiv-ratio-line') addBidIvRatioNeed(snapshot, needs, widget);
    else if (type.startsWith('ndate-skew-')) addNDateNeed(snapshot, needs, widget);
  }
  return needs;
}

function buildMap(quotes, side, field, fallback = {}) {
  const out = {};
  for (const quote of quotes) {
    if (quoteType(quote) !== side) continue;
    const strike = toNum(quote?.strike);
    if (!Number.isFinite(strike)) continue;
    const fromQuote = toNum(quote?.[field]);
    const fromFallback = toNum(fallback[strike]);
    out[strike] = Number.isFinite(fromQuote) ? fromQuote : (Number.isFinite(fromFallback) ? fromFallback : null);
  }
  return out;
}

function buildStrikes(quotes, side) {
  return Array.from(new Set(
    quotes.filter((quote) => quoteType(quote) === side).map((quote) => toNum(quote?.strike)).filter(Number.isFinite)
  )).sort((a, b) => a - b);
}

function compactExpirySnapshot(source, need, rootSnapshot) {
  const sourceQuotes = Array.isArray(source?.optionQuotes) ? source.optionQuotes : [];
  const quotes = need?.allQuotes
    ? sourceQuotes
    : sourceQuotes.filter((quote) => {
      const strike = toNum(quote?.strike);
      const type = quoteType(quote);
      if (!Number.isFinite(strike) || (type !== 'put' && type !== 'call')) return false;
      return need?.quoteKeys?.has(quoteKey(type, strike));
    });
  const compactQuotes = quotes.map(compactQuote);
  const callStrikesAsc = buildStrikes(compactQuotes, 'call');
  const putStrikesAsc = buildStrikes(compactQuotes, 'put');
  const strikesSorted = Array.from(new Set([...callStrikesAsc, ...putStrikesAsc])).sort((a, b) => a - b);
  const px = toNum(source?.px ?? rootSnapshot?.px);
  const { lower, upper } = findStrikesAroundPrice(strikesSorted, px);
  const atmPutIv = toNum(source?.putIvByStrike?.[lower]) ?? toNum(source?.putBidIvByStrike?.[lower]);
  const atmCallIv = toNum(source?.callIvByStrike?.[upper]) ?? toNum(source?.callBidIvByStrike?.[upper]);
  const atmValues = [atmPutIv, atmCallIv].filter(Number.isFinite);

  return {
    time: source?.time ?? rootSnapshot?.time ?? null,
    px,
    lower,
    upper,
    atmPutIv: Number.isFinite(atmPutIv) ? atmPutIv : null,
    atmCallIv: Number.isFinite(atmCallIv) ? atmCallIv : null,
    putBidIvByStrike: buildMap(compactQuotes, 'put', 'bid_iv', source?.putBidIvByStrike || {}),
    putBidByStrike: buildMap(compactQuotes, 'put', 'bid', source?.putBidByStrike || {}),
    putIvByStrike: buildMap(compactQuotes, 'put', 'iv', source?.putIvByStrike || {}),
    putStrikesAsc,
    putStrikesDesc: [...putStrikesAsc].reverse(),
    callBidIvByStrike: buildMap(compactQuotes, 'call', 'bid_iv', source?.callBidIvByStrike || {}),
    callBidByStrike: buildMap(compactQuotes, 'call', 'bid', source?.callBidByStrike || {}),
    callIvByStrike: buildMap(compactQuotes, 'call', 'iv', source?.callIvByStrike || {}),
    callStrikesAsc,
    optionQuotes: compactQuotes,
    atmIv: atmValues.length ? atmValues.reduce((sum, value) => sum + value, 0) / atmValues.length : null,
    storage: {
      trimmed: true,
      trimVersion: SNAPSHOT_TRIM_VERSION
    }
  };
}

function copyRootFields(snapshot, primaryExpiry, primarySnapshot, byExpiry) {
  const out = {
    time: snapshot?.time ?? primarySnapshot?.time ?? null,
    px: snapshot?.px ?? primarySnapshot?.px ?? null,
    expiry: primaryExpiry || snapshot?.expiry || null,
    lower: primarySnapshot?.lower ?? snapshot?.lower ?? null,
    upper: primarySnapshot?.upper ?? snapshot?.upper ?? null,
    dAtm: snapshot?.dAtm ?? null,
    metrics: snapshot?.metrics && typeof snapshot.metrics === 'object' ? { ...snapshot.metrics } : undefined,
    byExpiry,
    storage: {
      trimmed: true,
      trimVersion: SNAPSHOT_TRIM_VERSION
    }
  };
  for (const field of [
    'atmPutIv',
    'atmCallIv',
    'putBidIvByStrike',
    'putBidByStrike',
    'putIvByStrike',
    'putStrikesAsc',
    'putStrikesDesc',
    'callBidIvByStrike',
    'callBidByStrike',
    'callIvByStrike',
    'callStrikesAsc',
    'optionQuotes',
    'atmIv'
  ]) {
    if (primarySnapshot?.[field] !== undefined) out[field] = primarySnapshot[field];
  }
  return out;
}

export function trimSnapshotForWidgets(snapshot, tab) {
  if (!snapshot || typeof snapshot !== 'object') return snapshot;
  if (snapshot.theBlock?.charts) {
    return {
      ...snapshot,
      storage: {
        trimmed: false,
        trimVersion: SNAPSHOT_TRIM_VERSION,
        reason: 'theblock-series-snapshot'
      }
    };
  }
  const needs = collectNeeds(snapshot, tab);
  const primary = primaryExpiryKey(snapshot);
  if (primary && !needs.has(primary)) addNeed(needs, primary);

  const byExpiry = {};
  for (const [expiry, need] of needs.entries()) {
    const entry = findExpiryEntry(snapshot, expiry);
    if (!entry?.[1]) continue;
    byExpiry[expiry] = compactExpirySnapshot(entry[1], need, snapshot);
  }

  const primarySnapshot = byExpiry[primary] || byExpiry[Object.keys(byExpiry)[0]] || null;
  return copyRootFields(snapshot, primary, primarySnapshot, byExpiry);
}
