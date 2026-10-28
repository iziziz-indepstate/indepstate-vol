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

export function normalizeSkewSmoothing(value) {
  return value === 'ma5' || value === 'ma15' ? value : 'linear';
}

export function skewRangeTime(value) {
  return /^(?:[01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(value || '') ? (value.length === 5 ? `${value}:00` : value) : '';
}

export function skewDisplayRange(config = {}) {
  const boundary = (date, time, end) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return end ? Infinity : -Infinity;
    const normalizedTime = skewRangeTime(time);
    if (normalizedTime || !end) return new Date(`${date}T${normalizedTime || '00:00:00'}`).getTime();
    // Advance the calendar day in local time, including days with DST changes.
    const nextDay = new Date(`${date}T00:00:00`);
    nextDay.setDate(nextDay.getDate() + 1);
    return nextDay.getTime() - 1;
  };
  const start = boundary(config.startDate, config.startTime, false);
  const end = boundary(config.endDate, config.endTime, true);
  // Archive files use New York dates; local boundaries can fall in adjacent files.
  return { start, end, archive: {
    startDate: Number.isFinite(start) ? skewSessionDate(start) : '',
    endDate: Number.isFinite(end) ? skewSessionDate(end) : ''
  } };
}

export function buildMultiExpirySeries(lines, config = {}) {
  const smoothing = normalizeSkewSmoothing(config.smoothing);
  const windowSize = smoothing === 'ma5' ? 5 : smoothing === 'ma15' ? 15 : 1;
  const { start, end } = skewDisplayRange(config);
  const filtered = lines.map((line) => ({ ...line, points: mergeSkewPoints(line.points).filter((p) => {
    const timestamp = Date.parse(p.timestamp);
    return timestamp >= start && timestamp <= end;
  }) }));
  const times = [...new Set(filtered.flatMap((l) => l.points.map((p) => Date.parse(p.timestamp))))].sort((a, b) => a - b);
  const x = times.map((t) => t / 1000);
  return { x, lines: filtered.map((line) => {
    const byTime = new Map(line.points.map((p) => [Date.parse(p.timestamp) / 1000, p]));
    // Other expirations' timestamps do not create artificial gaps in this line.
    const meta = x.map((t) => byTime.get(t) || null);
    const window = [];
    const data = meta.map((point) => {
      if (!point) return undefined;
      if (!Number.isFinite(point.skew)) return null;
      // Only valid observations from this expiration consume the trailing window.
      window.push(point.skew * 100);
      if (window.length > windowSize) window.shift();
      return window.reduce((sum, value) => sum + value, 0) / window.length;
    });
    return { expiration: line.expiration, meta, data };
  }) };
}
