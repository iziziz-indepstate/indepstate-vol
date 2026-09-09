const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createTradingCalendarProvider,
  normalizeMarketHolidays
} = require('../src/main/trading-calendar-provider.cjs');

function cacheDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'is-vol-calendar-'));
}

function response(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  };
}

function writeCache(dir, payload) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'us-market-holidays.json'), JSON.stringify(payload), 'utf-8');
}

test('normalizeMarketHolidays keeps full closures and excludes early closes', () => {
  assert.deepEqual(
    normalizeMarketHolidays({
      holidays: [
        { date: '2026-01-01', status: 'Closed' },
        { date: '2026-11-27', status: 'Early Close 1:00 p.m.' },
        { date: '20261225', name: 'Christmas Day' }
      ]
    }),
    ['2026-01-01', '2026-12-25']
  );
});

test('calendar provider uses current cache without fetching', async () => {
  const dir = cacheDir();
  writeCache(dir, {
    cacheYear: 2026,
    years: {
      2026: ['2026-01-01'],
      2027: ['2027-01-01']
    }
  });
  const provider = createTradingCalendarProvider({
    cacheDir: dir,
    now: () => new Date('2026-09-09T12:00:00Z'),
    fetchImpl: async () => {
      throw new Error('fetch should not be called');
    }
  });

  assert.deepEqual(await provider.getMarketHolidays(), ['2026-01-01', '2027-01-01']);
});

test('calendar provider fetches missing cache years and writes cache', async () => {
  const dir = cacheDir();
  const calls = [];
  const provider = createTradingCalendarProvider({
    cacheDir: dir,
    now: () => new Date('2026-09-09T12:00:00Z'),
    fetchImpl: async (url) => {
      calls.push(String(url));
      const year = String(url).match(/(\d{4})\.json$/)?.[1];
      return response({ holidays: [{ date: `${year}-01-01`, status: 'Closed' }] });
    }
  });

  assert.deepEqual(await provider.getMarketHolidays(), ['2026-01-01', '2027-01-01']);
  assert.equal(calls.length, 2);
  const cached = JSON.parse(fs.readFileSync(path.join(dir, 'us-market-holidays.json'), 'utf-8'));
  assert.equal(cached.cacheYear, 2026);
  assert.deepEqual(cached.years['2027'], ['2027-01-01']);
});

test('calendar provider refreshes stale-year cache', async () => {
  const dir = cacheDir();
  writeCache(dir, {
    cacheYear: 2025,
    years: {
      2026: ['2026-12-31'],
      2027: ['2027-12-31']
    }
  });
  let calls = 0;
  const provider = createTradingCalendarProvider({
    cacheDir: dir,
    now: () => new Date('2026-09-09T12:00:00Z'),
    fetchImpl: async (url) => {
      calls += 1;
      const year = String(url).match(/(\d{4})\.json$/)?.[1];
      return response({ holidays: [{ date: `${year}-01-01`, status: 'Closed' }] });
    }
  });

  assert.deepEqual(await provider.getMarketHolidays(), ['2026-01-01', '2027-01-01']);
  assert.equal(calls, 2);
});

test('calendar provider falls back to valid cache when remote refresh fails', async () => {
  const dir = cacheDir();
  writeCache(dir, {
    cacheYear: 2025,
    years: {
      2026: ['2026-04-03'],
      2027: ['2027-03-26']
    }
  });
  const provider = createTradingCalendarProvider({
    cacheDir: dir,
    now: () => new Date('2026-09-09T12:00:00Z'),
    fetchImpl: async () => response({}, { status: 503 })
  });

  assert.deepEqual(await provider.getMarketHolidays(), ['2026-04-03', '2027-03-26']);
});
