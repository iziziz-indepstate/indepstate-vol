const EXPIRY_PLACEHOLDER_KEYS = Object.freeze(['today', 'nextWeek', 'nextMonth']);

export function parseExpiryDate(value) {
  const raw = String(value || '').trim();
  if (!/^\d{8}$/.test(raw)) return null;

  const y = Number(raw.slice(0, 4));
  const m = Number(raw.slice(4, 6));
  const d = Number(raw.slice(6, 8));
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt;
}

export function fmtExpiryDate(dt) {
  return [
    dt.getUTCFullYear(),
    String(dt.getUTCMonth() + 1).padStart(2, '0'),
    String(dt.getUTCDate()).padStart(2, '0')
  ].join('');
}

function fmtIsoDate(dt) {
  return [
    dt.getUTCFullYear(),
    String(dt.getUTCMonth() + 1).padStart(2, '0'),
    String(dt.getUTCDate()).padStart(2, '0')
  ].join('-');
}

function localDateAsUtc(value) {
  const dt = value instanceof Date ? value : new Date(value || Date.now());
  return new Date(Date.UTC(dt.getFullYear(), dt.getMonth(), dt.getDate()));
}

function addUtcDays(dt, days) {
  return new Date(dt.getTime() + days * 24 * 60 * 60 * 1000);
}

function startOfWeekMonday(dt) {
  const dow = dt.getUTCDay();
  const offset = dow === 0 ? -6 : 1 - dow;
  return addUtcDays(dt, offset);
}

function normalizeMarketHolidays(values) {
  const set = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const raw = String(value || '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) set.add(raw);
    else if (/^\d{8}$/.test(raw)) set.add(`${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`);
  }
  return set;
}

function isTradingDay(dt, holidaySet) {
  const day = dt.getUTCDay();
  return day !== 0 && day !== 6 && !holidaySet.has(fmtIsoDate(dt));
}

function nextTradingDay(dt, holidaySet) {
  let cursor = new Date(dt);
  for (let i = 0; i < 14; i += 1) {
    if (isTradingDay(cursor, holidaySet)) return cursor;
    cursor = addUtcDays(cursor, 1);
  }
  throw new Error('Could not resolve next trading day');
}

function previousTradingDay(dt, holidaySet) {
  let cursor = new Date(dt);
  for (let i = 0; i < 14; i += 1) {
    if (isTradingDay(cursor, holidaySet)) return cursor;
    cursor = addUtcDays(cursor, -1);
  }
  throw new Error('Could not resolve previous trading day');
}

function lastFridayMonthlyExpiry(year, monthIndex, holidaySet) {
  const monthEnd = new Date(Date.UTC(year, monthIndex + 1, 0));
  const offset = (monthEnd.getUTCDay() + 2) % 7;
  return previousTradingDay(addUtcDays(monthEnd, -offset), holidaySet);
}

export function canonicalExpiryPlaceholderKey(value) {
  const key = String(value || '').trim().toLowerCase();
  if (key === 'today') return 'today';
  if (key === 'nextweek') return 'nextWeek';
  if (key === 'nextmonth') return 'nextMonth';
  return null;
}

export function collectExpiryPlaceholderKeys(...values) {
  const found = new Set();
  for (const value of values) {
    for (const item of String(value || '').split(',')) {
      const key = canonicalExpiryPlaceholderKey(item);
      if (key) found.add(key);
    }
  }
  return EXPIRY_PLACEHOLDER_KEYS.filter((key) => found.has(key));
}

export function hasExpiryPlaceholder(...values) {
  return collectExpiryPlaceholderKeys(...values).length > 0;
}

export function resolveExpiryPlaceholders(options = {}) {
  const base = localDateAsUtc(options.now);
  const holidays = normalizeMarketHolidays(options.marketHolidays);
  const nextWeekEnd = addUtcDays(startOfWeekMonday(base), 13);
  const nextWeek = previousTradingDay(nextWeekEnd, holidays);
  let nextMonth = lastFridayMonthlyExpiry(base.getUTCFullYear(), base.getUTCMonth(), holidays);
  if (fmtExpiryDate(nextMonth) === fmtExpiryDate(nextWeek)) {
    nextMonth = lastFridayMonthlyExpiry(base.getUTCFullYear(), base.getUTCMonth() + 1, holidays);
  }

  return {
    today: fmtExpiryDate(nextTradingDay(base, holidays)),
    nextWeek: fmtExpiryDate(nextWeek),
    nextMonth: fmtExpiryDate(nextMonth)
  };
}

export function resolveExpiryToken(value, placeholders = {}) {
  const raw = String(value || '').trim();
  const placeholder = canonicalExpiryPlaceholderKey(raw);
  if (!placeholder) return { value: raw, placeholder: null };
  return {
    value: placeholders[placeholder] || raw,
    placeholder
  };
}

export function expandExpiryRange(startValue, endValue) {
  const start = parseExpiryDate(startValue);
  if (!start) return [];

  const parsedEnd = parseExpiryDate(endValue);
  const end = parsedEnd && parsedEnd >= start ? parsedEnd : start;
  const out = [];
  let cursor = new Date(start);
  while (cursor <= end) {
    out.push(fmtExpiryDate(cursor));
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
  }
  return out;
}

export function buildExpiryList(startValue, endValue, options = {}) {
  const expiryStart = String(startValue || '').trim();
  const placeholders = resolveExpiryPlaceholders(options);
  const usedPlaceholders = {};
  const resolve = (value) => {
    const result = resolveExpiryToken(value, placeholders);
    if (result.placeholder) usedPlaceholders[result.placeholder] = result.value;
    return result.value;
  };

  if (expiryStart.includes(',')) {
    const seen = new Set();
    const expiries = [];
    for (const raw of expiryStart.split(',')) {
      const expiry = resolve(raw);
      if (!expiry) continue;
      if (!parseExpiryDate(expiry)) {
        throw new Error(`Invalid expiry in comma-separated list: ${raw.trim()}`);
      }
      if (seen.has(expiry)) continue;
      seen.add(expiry);
      expiries.push(expiry);
    }
    for (const key of options.placeholderKeys || []) {
      if (EXPIRY_PLACEHOLDER_KEYS.includes(key)) usedPlaceholders[key] = placeholders[key];
    }
    return options.includeMetadata ? { expiries, placeholders: usedPlaceholders } : expiries;
  }

  const expiryEnd = String(endValue || '').trim();
  const resolvedStart = resolve(expiryStart);
  const resolvedEnd = expiryEnd ? resolve(expiryEnd) : resolvedStart;
  const expiries = expandExpiryRange(resolvedStart, resolvedEnd || resolvedStart);
  const list = expiries.length ? expiries : [resolvedStart].filter(Boolean);
  for (const key of options.placeholderKeys || []) {
    if (EXPIRY_PLACEHOLDER_KEYS.includes(key)) usedPlaceholders[key] = placeholders[key];
  }
  return options.includeMetadata ? { expiries: list, placeholders: usedPlaceholders } : list;
}
