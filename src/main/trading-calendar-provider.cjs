const fs = require('fs');
const path = require('path');

const API_BASE = 'https://the-calendar.net';
const MARKET_HOLIDAYS_ENDPOINT = '/api/finance/market-holidays';

function cacheFile(cacheDir) {
  return path.join(cacheDir, 'us-market-holidays.json');
}

function localYear(value) {
  const dt = value instanceof Date ? value : new Date(value || Date.now());
  return dt.getFullYear();
}

function requiredYears(now = new Date()) {
  const year = localYear(now);
  return [year, year + 1];
}

function readCache(cacheDir) {
  try {
    return JSON.parse(fs.readFileSync(cacheFile(cacheDir), 'utf-8'));
  } catch (_error) {
    return null;
  }
}

function writeCache(cacheDir, payload) {
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(cacheFile(cacheDir), JSON.stringify(payload, null, 2), 'utf-8');
  return payload;
}

function normalizeDate(value) {
  const text = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  return null;
}

function isFullClosure(row) {
  const text = [
    row?.status,
    row?.marketStatus,
    row?.kind,
    row?.type,
    row?.note,
    row?.name
  ].filter(Boolean).join(' ').toLowerCase();
  if (text.includes('early close') || text.includes('half day')) return false;
  return true;
}

function extractHolidayRows(json) {
  if (Array.isArray(json)) return json;
  for (const key of ['holidays', 'marketHolidays', 'events', 'data']) {
    const value = json?.[key];
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object') {
      const nested = extractHolidayRows(value);
      if (nested.length) return nested;
    }
  }
  return [];
}

function normalizeMarketHolidays(json) {
  const dates = [];
  for (const row of extractHolidayRows(json)) {
    const date = normalizeDate(row?.date || row?.observed || row?.start || row?.day);
    if (!date || !isFullClosure(row)) continue;
    dates.push(date);
  }
  return Array.from(new Set(dates)).sort();
}

function cacheHasYears(cache, years) {
  return Boolean(cache?.years && years.every((year) => Array.isArray(cache.years[String(year)])));
}

function cacheIsCurrent(cache, years, now = new Date()) {
  return cache?.cacheYear === localYear(now) && cacheHasYears(cache, years);
}

async function fetchYear(year, fetchImpl = global.fetch) {
  const url = `${API_BASE}${MARKET_HOLIDAYS_ENDPOINT}/${year}.json`;
  const response = await fetchImpl(url, { headers: { 'User-Agent': 'IS-VOL/1.0' } });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
  const dates = normalizeMarketHolidays(await response.json());
  if (!dates.length) throw new Error(`No full market holidays found for ${year}`);
  return dates;
}

function nthWeekdayOfMonth(year, monthIndex, weekday, nth) {
  let count = 0;
  for (let day = 1; day <= 31; day += 1) {
    const dt = new Date(Date.UTC(year, monthIndex, day));
    if (dt.getUTCMonth() !== monthIndex) break;
    if (dt.getUTCDay() !== weekday) continue;
    count += 1;
    if (count === nth) return dt;
  }
  return null;
}

function lastWeekdayOfMonth(year, monthIndex, weekday) {
  for (let day = 31; day >= 1; day -= 1) {
    const dt = new Date(Date.UTC(year, monthIndex, day));
    if (dt.getUTCMonth() !== monthIndex) continue;
    if (dt.getUTCDay() === weekday) return dt;
  }
  return null;
}

function observedFixedHoliday(year, monthIndex, day) {
  const dt = new Date(Date.UTC(year, monthIndex, day));
  const dow = dt.getUTCDay();
  if (dow === 6) return new Date(Date.UTC(year, monthIndex, day - 1));
  if (dow === 0) return new Date(Date.UTC(year, monthIndex, day + 1));
  return dt;
}

function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31) - 1;
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month, day));
}

function fmtIsoDate(dt) {
  return [
    dt.getUTCFullYear(),
    String(dt.getUTCMonth() + 1).padStart(2, '0'),
    String(dt.getUTCDate()).padStart(2, '0')
  ].join('-');
}

function computedMarketHolidays(year) {
  const goodFriday = new Date(easterSunday(year).getTime() - 2 * 24 * 60 * 60 * 1000);
  return [
    observedFixedHoliday(year, 0, 1),
    nthWeekdayOfMonth(year, 0, 1, 3),
    nthWeekdayOfMonth(year, 1, 1, 3),
    goodFriday,
    lastWeekdayOfMonth(year, 4, 1),
    observedFixedHoliday(year, 5, 19),
    observedFixedHoliday(year, 6, 4),
    nthWeekdayOfMonth(year, 8, 1, 1),
    nthWeekdayOfMonth(year, 10, 4, 4),
    observedFixedHoliday(year, 11, 25)
  ].filter(Boolean).map(fmtIsoDate).sort();
}

function flattenYears(years, byYear) {
  return Array.from(new Set(
    years.flatMap((year) => byYear[String(year)] || [])
  )).sort();
}

function createTradingCalendarProvider({ cacheDir, fetchImpl = global.fetch, now = () => new Date() } = {}) {
  if (!cacheDir) throw new Error('cacheDir is required');

  async function getMarketHolidays(referenceDate) {
    const currentNow = referenceDate || now();
    const years = requiredYears(currentNow);
    const cached = readCache(cacheDir);
    if (cacheIsCurrent(cached, years, currentNow)) return flattenYears(years, cached.years);

    try {
      const nextYears = { ...(cached?.years || {}) };
      for (const year of years) {
        try {
          nextYears[String(year)] = await fetchYear(year, fetchImpl);
        } catch (error) {
          if (cacheHasYears(cached, years)) throw error;
          nextYears[String(year)] = computedMarketHolidays(year);
        }
      }
      const saved = writeCache(cacheDir, {
        source: `${API_BASE}${MARKET_HOLIDAYS_ENDPOINT}/{year}.json`,
        cacheYear: localYear(currentNow),
        updatedAt: new Date().toISOString(),
        years: nextYears
      });
      return flattenYears(years, saved.years);
    } catch (error) {
      if (cacheHasYears(cached, years)) return flattenYears(years, cached.years);
      throw error;
    }
  }

  return { getMarketHolidays };
}

module.exports = {
  createTradingCalendarProvider,
  normalizeMarketHolidays,
  requiredYears,
  cacheIsCurrent,
  cacheHasYears
};
