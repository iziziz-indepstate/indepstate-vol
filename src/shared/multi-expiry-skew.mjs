import { calculateZeroDteSkewPoint, normalizeSkewDelta, skewSessionDate } from './zero-dte-skew-calculations.mjs';

const rthTime = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit',
  second: '2-digit', fractionalSecondDigits: 3, hourCycle: 'h23'
});

export function normalizeRthStartOffset(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(390, Math.max(0, Math.trunc(number))) : 0;
}

function isRth(timestamp, startOffset = 0) {
  const parts = Object.fromEntries(rthTime.formatToParts(timestamp).map(({ type, value }) => [type, value]));
  const seconds = Number(parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second)
    + Number(parts.fractionalSecond) / 1000;
  return parts.weekday !== 'Sat' && parts.weekday !== 'Sun' && seconds >= 9.5 * 3600 + startOffset * 60 && seconds <= 16 * 3600;
}

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

export function normalizeSkewSide(value) {
  return ['put', 'call', 'both', 'spread'].includes(value) ? value : 'spread';
}

export function migrateMultiExpirySkewConfig(widget) {
  if (widget?.type !== 'multi-expiry-skew') return false;
  widget.config ||= {};
  let changed = false;
  if (widget.config.side == null) { widget.config.side = 'spread'; changed = true; }
  if (!Array.isArray(widget.config.hiddenSeries)) {
    widget.config.hiddenSeries = normalizeSkewExpirations(widget.config.hiddenExpirations).map((expiry) => `${expiry}:spread`);
    changed = true;
  }
  return changed;
}

// Preserve each valid measurement independently when backfilling partial snapshots.
export function mergeSkewPoint(previous, incoming) {
  if (!previous) return incoming;
  const merged = { ...previous, ...incoming };
  for (const key of ['skew', 'atmIV', 'atmStrike', 'putWing', 'callWing']) {
    if (!Number.isFinite(incoming[key]) && Number.isFinite(previous[key])) merged[key] = previous[key];
  }
  for (const side of ['put', 'call']) {
    if (!Number.isFinite(incoming[side]?.iv) && Number.isFinite(previous[side]?.iv)) merged[side] = previous[side];
  }
  return merged;
}

export function mergeSkewPoints(...groups) {
  const points = new Map();
  for (const p of groups.flat()) {
    const time = Date.parse(p?.timestamp);
    if (!Number.isFinite(time)) continue;
    points.set(time, mergeSkewPoint(points.get(time), p));
  }
  return [...points.values()].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
}

export function calculateMultiExpiryPoints(history, config) {
  return normalizeSkewExpirations(config.expirations).map((expiration) => ({ expiration,
    points: mergeSkewPoints((history || []).map((s) => {
      const { timestamp, sessionDate, targetDelta, skew, put, call, atmIV, atmStrike, putWing, callWing, warning } = calculateZeroDteSkewPoint(s, { expiration, targetDelta: config.targetDelta });
      return { timestamp: Number.isFinite(new Date(timestamp ?? '').getTime()) ? new Date(timestamp).toISOString() : null,
        expiration, sessionDate, targetDelta, skew, put, call, atmIV, atmStrike, putWing, callWing,
        warning };
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
  // RTH uses a daily offset from the New York opening; dates bound local calendar days.
  const start = boundary(config.startDate, config.rthOnly === true ? '' : config.startTime, false);
  const end = boundary(config.endDate, config.rthOnly === true ? '' : config.endTime, true);
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
  const startOffset = normalizeRthStartOffset(config.rthStartOffsetMinutes);
  const filtered = lines.map((line) => ({ ...line, points: mergeSkewPoints(line.points).filter((p) => {
    const timestamp = Date.parse(p.timestamp);
    if (timestamp < start || timestamp > end) return false;
    if (config.rthOnly !== true) return true;
    return isRth(timestamp, startOffset);
  }) }));
  const times = [...new Set(filtered.flatMap((l) => l.points.map((p) => Date.parse(p.timestamp))))].sort((a, b) => a - b);
  const x = times.map((t) => t / 1000);
  const side = normalizeSkewSide(config.side);
  const metrics = side === 'both' ? ['put', 'call'] : [side];
  return { x, lines: filtered.flatMap((line) => metrics.map((metric) => {
    const byTime = new Map(line.points.map((p) => [Date.parse(p.timestamp) / 1000, p]));
    // Other expirations' timestamps do not create artificial gaps in this line.
    const meta = x.map((t) => byTime.get(t) || null);
    const window = [];
    const data = meta.map((point) => {
      if (!point) return undefined;
      const value = point[metric === 'spread' ? 'skew' : `${metric}Wing`];
      if (!Number.isFinite(value)) return null;
      // Only valid observations from this expiration consume the trailing window.
      window.push(value * 100);
      if (window.length > windowSize) window.shift();
      return window.reduce((sum, value) => sum + value, 0) / window.length;
    });
    return { id: `${line.expiration}:${metric}`, metric, expiration: line.expiration, meta, data };
  })) };
}
