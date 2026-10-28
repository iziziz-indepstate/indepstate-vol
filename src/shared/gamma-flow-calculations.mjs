// Observed transaction gamma, never an estimate of dealer positions.
export const GAMMA_DEFAULTS = Object.freeze({
  gammaMode: 'executed', gammaOptionTypes: 'total', gammaStrikeScope: 'dynamic',
  gammaWidth: 3, gammaStrikes: '', gammaAnchorAt: '', gammaAnchorStrike: '', gammaAnchorStrikes: '',
  gammaWindow: 'session', gammaMinutes: 5, gammaStart: '', gammaQuality: 'all',
  gammaAnalysis: 'iv', gammaQuoteMaxAgeSeconds: 60, gammaDebug: false, excludeFlaggedTrades: false
});
const SEGMENTS = ['downside', 'atm', 'upside'];
export function normalizeGammaParam(name, value, current) {
  if (name === 'gammaDebug') return value === true || value === 'true';
  const str = String(value ?? '').trim();
  const enums = {
    gammaMode: ['executed', 'revalued'], gammaOptionTypes: ['total', 'call', 'put'],
    gammaStrikeScope: ['dynamic', 'anchored', 'explicit'], gammaWindow: ['session', 'rolling', 'anchored'],
    gammaQuality: ['all', 'reliable'], gammaAnalysis: ['iv', 'relative']
  };
  const fallback = current ?? GAMMA_DEFAULTS[name];
  if (enums[name]) return enums[name].includes(str) ? str : fallback;
  if (['gammaWidth', 'gammaMinutes', 'gammaQuoteMaxAgeSeconds'].includes(name)) {
    const n = number(str);
    return n != null && Number.isInteger(n) && n >= (name === 'gammaWidth' ? 0 : 1) ? n : fallback;
  }
  if (['gammaAnchorAt', 'gammaStart'].includes(name)) return !str || absoluteMs(str) != null ? str : fallback;
  if (name === 'gammaStrikes') return !str || parseGammaStrikes(str) ? str : fallback;
  return fallback;
}
const marketFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
});
export function number(value) {
  if (value == null || value === '') return null;
  const n = Number(typeof value === 'string' ? value.replace(/[$,%\s]/g, '') : value);
  return Number.isFinite(n) ? n : null;
}
export function absoluteMs(value) {
  return typeof value === 'string' && /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
}
function marketParts(ms) {
  return Object.fromEntries(marketFormatter.formatToParts(ms).map((p) => [p.type, p.value]));
}
function dateAt(ms) {
  const p = marketParts(ms);
  return `${p.year}-${p.month}-${p.day}`;
}
// Resolve a local wall clock using the zone offset at that date (including DST).
function zonedMs(date, clock, zone) {
  try {
    const target = Date.parse(`${date}T${clock}Z`);
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    });
    let result = target;
    for (let i = 0; i < 3; i++) {
      const p = Object.fromEntries(fmt.formatToParts(result).map((v) => [v.type, v.value]));
      const local = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`) + new Date(result).getUTCMilliseconds();
      result += target - local;
    }
    return Number.isFinite(result) ? result : null;
  } catch { return null; }
}
export function executionMs(row) {
  // The tape timestamp is authoritative. executed_at is only a legacy alias.
  const raw = String(row.timestamp || row.executed_at || '').trim();
  if (!raw) return null;
  const absolute = absoluteMs(raw);
  if (absolute != null) return absolute;
  const zone = row.timezone || 'America/New_York';
  const local = raw.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?)$/);
  if (local) return zonedMs(local[1], local[2], zone);
  if (!/^\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/.test(raw)) return null;
  try {
    // A time-only 0DTE execution belongs to its expiration date, including replayed dumps.
    const date = /^\d{4}-\d{2}-\d{2}$/.test(row.expiration || '') ? row.expiration
      : absoluteMs(row._sentAt) != null ? new Intl.DateTimeFormat('en-CA', {
        timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit'
      }).format(Date.parse(row._sentAt)) : null;
    return date ? zonedMs(date, raw, zone) : null;
  } catch { return null; }
}
function key(row) { return `${row.expiration}|${row.strike}|${row.call_put}`; }
function eligibleRoot(row) { return ['SPX', 'SPXW'].includes(String(row.underlying).toUpperCase()); }
function nearest(strikes, spot) {
  if (!(spot > 0) || !strikes.length) return null;
  return strikes.reduce((best, k) => Math.abs(k - spot) < Math.abs(best - spot) ? k : best);
}
function ladderAround(strikes, atm, width) {
  const idx = strikes.indexOf(atm);
  return idx < 0 ? [] : strikes.slice(Math.max(0, idx - width), idx + width + 1);
}
export function parseGammaStrikes(value) {
  const str = String(value || '').trim();
  const range = str.match(/^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/);
  if (range) return Number(range[1]) <= Number(range[2]) ? { min: +range[1], max: +range[2] } : null;
  const values = str.split(',').map((s) => s.trim()).filter(Boolean).map(Number);
  return values.length && values.every((n) => Number.isFinite(n) && n > 0) ? [...new Set(values)].sort((a, b) => a - b) : null;
}
export function gammaScopeKey(config) {
  const c = { ...GAMMA_DEFAULTS, ...config };
  const scope = [c.gammaStrikeScope, Number(c.gammaWidth), c.gammaStrikes,
    c.gammaAnchorAt, c.gammaAnchorStrike, c.gammaAnchorStrikes, c.gammaQuality];
  if (c.excludeFlaggedTrades === true) scope.push('excludeFlaggedTrades');
  return JSON.stringify(scope);
}
export function captureGammaAnchor(history, at = new Date().toISOString()) {
  const ms = absoluteMs(at);
  if (ms == null) return null;
  const rows = [], prices = [];
  for (const s of history || []) {
    if (s.provider !== 'tape-contract' || Date.parse(s.time) > ms) continue;
    for (const kind of ['tape', 'quote', 'contract']) {
      for (const row of s[kind]?.records || []) {
        const t = kind === 'tape' ? executionMs(row) : Date.parse(row.timestamp || s.time);
        if (eligibleRoot(row) && t != null && t <= ms) {
          if (row.expiration === dateAt(ms)) rows.push({ row, t });
          if (kind === 'tape' && number(row.underlying_price) > 0) prices.push({ t, spot: number(row.underlying_price) });
        }
      }
    }
  }
  rows.sort((a, b) => a.t - b.t);
  const strikes = [...new Set(rows.map(({ row }) => number(row.strike)).filter((n) => n > 0))].sort((a, b) => a - b);
  const spot = prices.sort((a, b) => a.t - b.t).at(-1)?.spot;
  const atm = nearest(strikes, spot);
  return atm == null ? null : { at, atm, strikes };
}
export function confirmedImbalance(b, z) {
  return b == null || z == null ? null : b === 0 ? 0 : b * (1 + Math.tanh(Math.sign(b) * z)) / 2;
}
function emptyBucket() { return { bought: 0, sold: 0, count: 0, missingQuotes: 0 }; }
function finishBucket(b) {
  const gross = b.bought + b.sold;
  const available = b.count > 0 && b.missingQuotes === 0;
  return { ...b, bought: available ? b.bought : null, sold: available ? b.sold : null,
    gross: available ? gross : null, net: available ? b.bought - b.sold : null,
    B: available && gross > 0 ? (b.bought - b.sold) / gross : null };
}
function goodQuote(q, t, cfg) {
  const age = t - absoluteMs(q?.timestamp);
  return q && absoluteMs(q.timestamp) != null && age >= 0 && age <= cfg.gammaQuoteMaxAgeSeconds * 1000
    && q.quality === 'reliable' && number(q.gamma) != null && number(q.gamma) >= 0
    && q.gamma_unit === 'per_point' && q.iv_unit === 'decimal' && number(q.iv) > 0
    && number(q.forward) > 0 && absoluteMs(q.expiration_at) > t;
}
function evidenceFor(calibrations, segment, t, start, expiry, cfg, receivedAt) {
  const p = marketParts(t);
  const minute = Number(p.hour) * 60 + Number(p.minute);
  return calibrations.findLast((r) => {
    const seconds = (absoluteMs(r.expiration_at) - t) / 1000;
    return r.expiration === expiry && r.segment === segment && r.scope_key === gammaScopeKey(cfg)
      && r.gamma_mode === cfg.gammaMode && r.option_types === cfg.gammaOptionTypes
      && absoluteMs(r.window_end) === t && absoluteMs(r.window_start) === start
      && r.quality === 'reliable' && r.historical === true && number(r.sample_count) > 0
      && r.iv_unit === 'decimal' && r.comparison_method === 'constant_forward_moneyness_adjusted'
      && number(r.tod_start_minute) != null && minute >= r.tod_start_minute && minute < r.tod_end_minute
      && number(r.min_seconds_to_expiry) != null && seconds >= r.min_seconds_to_expiry && seconds <= r.max_seconds_to_expiry;
  });
}
function analyticalMetrics(buckets, calibrations, quotes, active, t, start, expiry, cfg, receivedAt) {
  const segments = {};
  for (const segment of SEGMENTS) {
    const b = finishBucket(buckets[segment]);
    const e = evidenceFor(calibrations, segment, t, start, expiry, cfg, receivedAt);
    // IV confirmation requires live, reliable quotes for every contributing contract.
    const hasQuotes = active.filter((r) => r.segment === segment).every((r) => goodQuote(quotes.get(key(r)), t, cfg));
    const usable = b.gross > 0 && e && hasQuotes;
    const z = usable && number(e.adjusted_iv_change) != null && number(e.iv_scale) > 0
      ? e.adjusted_iv_change / e.iv_scale : null;
    segments[segment] = { ...b, Z: z, C: confirmedImbalance(b.B, z),
      ivStart: usable && number(e.comparable_iv_start) > 0 ? number(e.comparable_iv_start) : null,
      ivEnd: usable && number(e.comparable_iv_end) > 0 ? number(e.comparable_iv_end) : null,
      skewScale: usable && number(e.skew_scale) > 0 ? number(e.skew_scale) : null,
      activity: !e || number(e.activity_threshold) == null ? 'uncalibrated'
        : b.gross == null ? 'unavailable' : b.gross < e.activity_threshold ? 'low' : 'sufficient',
      reason: !(b.gross > 0) ? 'No representative gamma activity' : !hasQuotes ? 'Missing or stale reliable quotes'
        : !e ? 'Missing matching historical calibration / adjusted IV' : z == null ? 'Missing adjusted IV or IV scale' : null };
  }
  const total = finishBucket(buckets.total);
  const contributing = SEGMENTS.filter((s) => segments[s].gross > 0);
  const z = total.gross > 0 && contributing.every((s) => segments[s].Z != null)
    ? contributing.reduce((sum, s) => sum + segments[s].gross * segments[s].Z, 0) / total.gross : null;
  const atm = segments.atm;
  for (const s of SEGMENTS) {
    const b = segments[s];
    b.skew = b.ivEnd != null && atm.ivEnd != null ? b.ivEnd - atm.ivEnd : null;
    b.deltaSkew = b.skew != null && b.ivStart != null && atm.ivStart != null ? b.skew - (b.ivStart - atm.ivStart) : null;
    b.relativeZ = s === 'atm' ? b.Z : b.deltaSkew != null && b.skewScale > 0 ? b.deltaSkew / b.skewScale : null;
    b.R = confirmedImbalance(b.B, b.relativeZ);
  }
  const d = segments.downside, u = segments.upside;
  return { ...total, Z: z, C: confirmedImbalance(total.B, z), segments,
    A: d.R != null && u.R != null ? (u.R - d.R) / 2 : null,
    downsideUpsideSkew: d.ivEnd != null && u.ivEnd != null ? d.ivEnd - u.ivEnd : null,
    deltaDownsideUpsideSkew: d.ivEnd != null && u.ivEnd != null && d.ivStart != null && u.ivStart != null
      ? (d.ivEnd - u.ivEnd) - (d.ivStart - u.ivStart) : null };
}

export function calculateGammaFlow(history, config = {}, checkpoint = null) {
  const cfg = { ...GAMMA_DEFAULTS, ...config };
  const snapshots = (history || []).filter((s) => s.provider === 'tape-contract' && absoluteMs(s.time) != null)
    .slice().sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  const previous = checkpoint?.first === snapshots[0] && checkpoint?.processed <= snapshots.length
    && checkpoint?.last === snapshots[checkpoint.processed - 1] ? checkpoint : null;
  const points = previous?.points || [], trades = previous?.trades || [], quoteHistory = previous?.quoteHistory || new Map();
  const tapeSpots = previous?.tapeSpots || [];
  const observed = previous?.observed || new Map(), seen = previous?.seen || new Set(), calibrations = previous?.calibrations || [];
  const excluded = previous?.excluded || {}, reject = (reason) => { excluded[reason] = (excluded[reason] || 0) + 1; };
  const explicit = parseGammaStrikes(cfg.gammaStrikes);
  const anchorLadder = parseGammaStrikes(cfg.gammaAnchorStrikes);
  const anchorAtm = number(cfg.gammaAnchorStrike);
  let lastNet = previous?.lastNet ?? null, lastValues = previous?.lastValues || new Map();
  let sourceClock = previous?.sourceClock ?? null, previousReceipt = previous?.previousReceipt ?? null;
  for (const snapshot of snapshots.slice(previous?.processed || 0)) {
    const receivedAt = Date.parse(snapshot.time);
    const sourceTimes = [
      ...(snapshot.tape?.records || []).filter(eligibleRoot).map(executionMs),
      ...(snapshot.quote?.records || []).filter(eligibleRoot).map((r) => absoluteMs(r.timestamp))
    ].filter((ms) => ms != null);
    if (sourceTimes.length) {
      const latest = sourceTimes.reduce((a, b) => Math.max(a, b));
      sourceClock = sourceClock == null ? latest : Math.max(sourceClock, latest);
    } else if (sourceClock != null && previousReceipt != null) {
      sourceClock += Math.max(0, receivedAt - previousReceipt);
    }
    previousReceipt = receivedAt;
    const observationTime = sourceClock ?? receivedAt;
    // A measurement is evaluated at its actual window end, not at the later HTTP drain time.
    // Empty polls advance the tape clock by elapsed time, never to the recorder's absolute clock.
    const measurementEnds = (snapshot.calibration?.records || []).filter((r) => eligibleRoot(r)
      && r.scope_key === gammaScopeKey(cfg) && r.gamma_mode === cfg.gammaMode && r.option_types === cfg.gammaOptionTypes
      && r.quality === 'reliable' && absoluteMs(r.window_end) <= observationTime
      && absoluteMs(r.window_end) > (absoluteMs(points.at(-1)?.timestamp) ?? -Infinity))
      .map((r) => absoluteMs(r.window_end));
    const t = measurementEnds.length ? Math.max(...measurementEnds) : observationTime, expiry = dateAt(t);
    const sessionStart = zonedMs(expiry, '09:30:00', 'America/New_York');
    const start = cfg.gammaWindow === 'rolling' ? t - Number(cfg.gammaMinutes) * 60000
      : cfg.gammaWindow === 'anchored' ? absoluteMs(cfg.gammaStart) : sessionStart;
    const windowValid = start != null && start <= t && (cfg.gammaWindow !== 'rolling' || Number(cfg.gammaMinutes) > 0);
    const events = [];
    for (const kind of ['quote', 'contract', 'tape']) {
      for (const row of snapshot[kind]?.records || []) {
        if (!eligibleRoot(row)) { if (kind === 'tape') reject('underlying'); continue; }
        const ms = kind === 'tape' ? executionMs(row) : absoluteMs(row.timestamp) ?? receivedAt;
        events.push({ kind, row, ms });
      }
    }
    events.sort((a, b) => (a.ms ?? Infinity) - (b.ms ?? Infinity));
    for (const { kind, row, ms } of events) {
      if (ms == null) { if (kind === 'tape') reject('execution_time'); continue; }
      if (kind === 'quote') {
        const versions = quoteHistory.get(key(row)) || [];
        if (!versions.some((q) => q.timestamp === row.timestamp)) {
          versions.push(row);
          versions.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
          quoteHistory.set(key(row), versions);
        }
      }
      if (number(row.strike) > 0) {
        const list = observed.get(row.expiration) || new Map();
        list.set(Number(row.strike), Math.min(list.get(Number(row.strike)) ?? ms, ms));
        observed.set(row.expiration, list);
      }
      if (kind !== 'tape') continue;
      const id = row._dedupeKey || row.trade_id_sequence || JSON.stringify([ms, row.expiration, row.strike, row.call_put, row.size_contracts, row.aggressor_buy_sell, row.premium]);
      if (seen.has(id)) { reject('duplicate'); continue; }
      seen.add(id);
      // Spot belongs to SPX, not to the widget's filtered option selection.
      // Even an execution without usable gamma/aggressor may update the underlying price.
      const tapeSpot = number(row.underlying_price);
      if (tapeSpot > 0) tapeSpots.push({ ms, spot: tapeSpot });
      if (cfg.excludeFlaggedTrades === true && String(row.condition_flag ?? '').trim()) { reject('condition_flag'); continue; }
      if (row.expiration !== dateAt(ms)) { reject('not_0dte'); continue; }
      if (!['CALL', 'PUT'].includes(row.call_put) || !(number(row.strike) > 0)) { reject('contract'); continue; }
      if (cfg.gammaQuality === 'reliable' && row.classification_quality !== 'reliable') { reject('classification_quality'); continue; }
      if (cfg.gammaOptionTypes !== 'total' && row.call_put.toLowerCase() !== cfg.gammaOptionTypes) { reject('option_type'); continue; }
      const spot = number(row.underlying_price), gamma = number(row.gamma);
      if (gamma == null) { reject('gamma'); continue; }
      if (!(spot > 0) && cfg.gammaStrikeScope !== 'anchored') { reject('execution_spot'); continue; }
      const ladder = [...(observed.get(row.expiration) || new Map()).entries()].filter(([, time]) => time <= ms).map(([k]) => k).sort((a, b) => a - b);
      const atm = cfg.gammaStrikeScope === 'anchored' ? anchorAtm : nearest(ladder, spot);
      let allowed;
      if (cfg.gammaStrikeScope === 'explicit') allowed = Array.isArray(explicit) ? explicit.includes(Number(row.strike))
        : explicit ? row.strike >= explicit.min && row.strike <= explicit.max : false;
      else if (cfg.gammaStrikeScope === 'anchored') allowed = Array.isArray(anchorLadder) && atm != null
        && ladderAround(anchorLadder, atm, Number(cfg.gammaWidth)).includes(Number(row.strike));
      else allowed = ladderAround(ladder, atm, Number(cfg.gammaWidth)).includes(Number(row.strike));
      if (!allowed || atm == null) { reject('strike_scope_or_anchor'); continue; }
      trades.push({ ...row, ms, id, segment: row.strike < atm ? 'downside' : row.strike > atm ? 'upside' : 'atm',
        executedGamma: gamma, includedAtm: atm });
    }
    for (const row of snapshot.calibration?.records || []) if (eligibleRoot(row)) calibrations.push(row);
    const quotes = new Map([...quoteHistory].map(([k, versions]) => {
      const idx = versions.findLastIndex((q) => absoluteMs(q.timestamp) <= t);
      const current = versions[idx];
      if (idx > 0) quoteHistory.set(k, versions.slice(idx));
      return [k, current];
    }));
    const active = windowValid ? trades.filter((r) => r.expiration === expiry && r.ms <= t
      && (cfg.gammaWindow === 'rolling' ? r.ms > start : r.ms >= start)) : [];
    const buckets = Object.fromEntries([...SEGMENTS, 'total', 'call', 'put'].map((s) => [s, emptyBucket()]));
    const values = new Map();
    // Latest known tape execution as of the observation, independent of strike/expiry/side filters.
    tapeSpots.sort((a, b) => a.ms - b.ms);
    const spotIndex = tapeSpots.findLastIndex((s) => s.ms <= t);
    const currentTapeSpot = tapeSpots[spotIndex];
    const currentSpot = currentTapeSpot?.spot ?? null;
    if (spotIndex > 0) tapeSpots.splice(0, spotIndex);
    for (const trade of active) {
      const q = quotes.get(key(trade));
      // Tape gamma already includes size and sign. Quote gamma is the current per-contract value
      // in the same source units; only the revalued mode needs the original contract quantity.
      const g = cfg.gammaMode === 'revalued' ? goodQuote(q, t, cfg) && number(trade.size_contracts) > 0
        ? Math.sign(trade.executedGamma) * trade.size_contracts * q.gamma : null : trade.executedGamma;
      for (const name of [trade.segment, 'total', trade.call_put.toLowerCase()]) {
        const b = buckets[name]; b.count++;
        if (g == null) b.missingQuotes++;
        else b[g >= 0 ? 'bought' : 'sold'] += Math.abs(g);
      }
      if (g != null) values.set(trade.id, g);
    }
    const metrics = analyticalMetrics(buckets, calibrations, quotes, active, t, start, expiry, cfg, receivedAt);
    const coverageStart = snapshots[0] ? Date.parse(snapshots[0].time) : null;
    const newFlow = metrics.net == null ? null : [...values].reduce((sum, [id, value]) => sum + (lastValues.has(id) ? 0 : value), 0);
    const expiredFlow = metrics.net == null || lastNet == null ? null : [...lastValues].reduce((sum, [id, value]) => sum - (values.has(id) ? 0 : value), 0);
    const revaluation = metrics.net == null || lastNet == null ? null : [...values].reduce((sum, [id, value]) => sum + (lastValues.has(id) ? value - lastValues.get(id) : 0), 0);
    const reason = !windowValid ? cfg.gammaWindow === 'session' && t < sessionStart
      ? 'Regular session has not opened (09:30 America/New_York)'
      : cfg.gammaWindow === 'anchored' ? 'Invalid, missing or future time anchor'
        : 'Invalid rolling window'
      : cfg.gammaStrikeScope === 'explicit' && !explicit ? 'Explicit strikes are empty or invalid'
      : cfg.gammaStrikeScope === 'anchored' && (!Array.isArray(anchorLadder) || anchorAtm == null) ? 'ATM anchor is unavailable'
      : !active.length ? 'No eligible trades in window'
      : metrics.missingQuotes ? 'Missing or stale current gamma quotes, or missing contract quantity' : null;
    points.push({ timestamp: new Date(t).toISOString(), receivedAt: snapshot.time, settings: { ...cfg }, scopeKey: gammaScopeKey(cfg), expiration: expiry,
      windowStart: start == null ? null : new Date(start).toISOString(), coverageStart: snapshots[0]?.time ?? null,
      completeCoverage: windowValid && coverageStart <= start, excluded: { ...excluded },
      reason, ...metrics, calls: finishBucket(buckets.call), puts: finishBucket(buckets.put),
      newFlow, expiredFlow, revaluation, currentSpot,
      currentSpotSource: currentTapeSpot ? 'tape.underlying_price' : null,
      currentSpotTimestamp: currentTapeSpot ? new Date(currentTapeSpot.ms).toISOString() : null,
      activity: SEGMENTS.some((s) => metrics.segments[s].activity === 'low') ? 'low'
        : SEGMENTS.filter((s) => metrics.segments[s].gross > 0).every((s) => metrics.segments[s].activity === 'sufficient') && metrics.gross > 0 ? 'sufficient' : 'uncalibrated' });
    lastNet = metrics.net;
    lastValues = metrics.net == null ? new Map() : values;
    // Earlier evidence cannot match any later observation. Retain future measurements only.
    for (let i = calibrations.length - 1; i >= 0; i--) {
      if (absoluteMs(calibrations[i].window_end) < t) calibrations.splice(i, 1);
    }
  }
  if (checkpoint) Object.assign(checkpoint, { first: snapshots[0], last: snapshots.at(-1), processed: snapshots.length,
    points, trades, quoteHistory, tapeSpots, observed, seen, calibrations, excluded, lastNet, lastValues, sourceClock, previousReceipt });
  return points;
}

// Append-only histories are processed once. A retention trim or settings change rebuilds from retained data.
export function createGammaFlowCalculator() {
  const histories = new WeakMap();
  return (history, config = {}) => {
    if (!Array.isArray(history)) return calculateGammaFlow([], config);
    const variants = histories.get(history) || new Map();
    const configKey = JSON.stringify({ ...GAMMA_DEFAULTS, ...config });
    const checkpoint = variants.get(configKey) || {};
    variants.delete(configKey);
    variants.set(configKey, checkpoint);
    if (variants.size > 8) variants.delete(variants.keys().next().value);
    histories.set(history, variants);
    return calculateGammaFlow(history, config, checkpoint);
  };
}
