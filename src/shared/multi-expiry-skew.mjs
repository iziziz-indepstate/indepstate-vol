import { calculateZeroDteSkewPoint, normalizeSkewDelta, skewSessionDate } from './zero-dte-skew-calculations.mjs';

export function normalizeSkewExpirations(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((v) => String(v).replaceAll('-', ''))
    .filter((v) => {
      if (!/^\d{8}$/.test(v)) return false;
      const date = new Date(`${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6)}T00:00:00Z`);
      return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10).replaceAll('-', '') === v;
    }))];
}

export function skewIdentity(source, expiration, targetDelta) {
  return { dataSourceId: source.id, symbol: String(source.providerConfig?.ticker || source.providerConfig?.root || '').toUpperCase(),
    expiration, targetDelta: normalizeSkewDelta(targetDelta) };
}

export function mergeSkewPoints(...groups) {
  const points = new Map();
  for (const p of groups.flat()) {
    const time = Date.parse(p?.timestamp);
    if (!Number.isFinite(time)) continue;
    if (!points.has(time) || Number.isFinite(p.skew) || !Number.isFinite(points.get(time).skew)) points.set(time, p);
  }
  return [...points.values()].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
}

export function calculateMultiExpiryPoints(history, config) {
  return normalizeSkewExpirations(config.expirations).map((expiration) => ({ expiration,
    points: mergeSkewPoints((history || []).map((s) => {
      const { timestamp, sessionDate, targetDelta, skew, put, call, warning } = calculateZeroDteSkewPoint(s, { expiration, targetDelta: config.targetDelta });
      return { timestamp: Number.isFinite(new Date(timestamp ?? '').getTime()) ? new Date(timestamp).toISOString() : null,
        expiration, sessionDate, targetDelta, skew, put, call,
        warning: warning.split('; ').filter((message) => message !== 'No valid ATM pair').join('; ') };
    })) }));
}

export function buildMultiExpirySeries(lines, config = {}) {
  const filtered = lines.map((line) => ({ ...line, points: mergeSkewPoints(line.points).filter((p) => {
    const date = skewSessionDate(p.timestamp);
    return (!config.startDate || date >= config.startDate.replaceAll('-', ''))
      && (!config.endDate || date <= config.endDate.replaceAll('-', ''));
  }) }));
  const times = [...new Set(filtered.flatMap((l) => l.points.map((p) => Date.parse(p.timestamp))))].sort((a, b) => a - b);
  const x = times.map((t) => t / 1000);
  return { x, lines: filtered.map((line) => {
    const byTime = new Map(line.points.map((p) => [Date.parse(p.timestamp) / 1000, p]));
    // Other expirations' timestamps do not create artificial gaps in this line.
    const meta = x.map((t) => byTime.get(t) || null);
    return { expiration: line.expiration, meta, data: x.map((t, i) => byTime.has(t)
      ? (Number.isFinite(meta[i].skew) ? meta[i].skew * 100 : null)
      : undefined) };
  }) };
}
