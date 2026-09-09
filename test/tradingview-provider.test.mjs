import test from 'node:test';
import assert from 'node:assert/strict';
import { TradingViewProvider, buildExpiryList, resolveExpiryPlaceholders } from '../src/shared/tradingview-provider.js';

function jsonResponse(body) {
  return {
    json: async () => body
  };
}

test('buildExpiryList keeps comma-separated expiries in user order', () => {
  assert.deepEqual(
    buildExpiryList('20260626, 20260612,20260619', '20260630'),
    ['20260626', '20260612', '20260619']
  );
});

test('buildExpiryList preserves existing range behavior without commas', () => {
  assert.deepEqual(
    buildExpiryList('20260612', '20260614'),
    ['20260612', '20260613', '20260614']
  );
});

test('resolveExpiryPlaceholders handles trading days, weekends, and holidays', () => {
  assert.deepEqual(
    resolveExpiryPlaceholders({
      now: new Date('2026-09-09T12:00:00Z'),
      marketHolidays: []
    }),
    { today: '20260909', nextWeek: '20260918', nextMonth: '20260925' }
  );

  assert.equal(
    resolveExpiryPlaceholders({
      now: new Date('2026-09-12T12:00:00Z'),
      marketHolidays: []
    }).today,
    '20260914'
  );

  assert.equal(
    resolveExpiryPlaceholders({
      now: new Date('2026-06-10T12:00:00Z'),
      marketHolidays: ['2026-06-19']
    }).nextWeek,
    '20260618'
  );
});

test('resolveExpiryPlaceholders moves nextMonth when it matches nextWeek', () => {
  assert.deepEqual(
    resolveExpiryPlaceholders({
      now: new Date('2026-09-17T12:00:00Z'),
      marketHolidays: []
    }),
    { today: '20260917', nextWeek: '20260925', nextMonth: '20261030' }
  );
});

test('buildExpiryList resolves mixed placeholders in user order', () => {
  assert.deepEqual(
    buildExpiryList('today, 20260930,nextWeek,nextMonth', '', {
      now: new Date('2026-09-09T12:00:00Z'),
      marketHolidays: []
    }),
    ['20260909', '20260930', '20260918', '20260925']
  );
});

test('TradingViewProvider fetches only explicit comma-separated expiries', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, body: options.body || '' });
    if (String(url).includes('query1.finance.yahoo.com')) {
      return jsonResponse({
        chart: {
          result: [{
            meta: { regularMarketPrice: 100 }
          }]
        }
      });
    }
    return jsonResponse({
      fields: ['strike', 'option-type', 'bid', 'ask', 'iv', 'bid_iv', 'delta', 'gamma', 'theta', 'vega'],
      symbols: []
    });
  };

  try {
    const provider = new TradingViewProvider({
      marketCalendar: {
        getMarketHolidays: async () => {
          throw new Error('calendar should not be called for literal expiries');
        }
      }
    });
    const snapshot = await provider.fetchSnapshot({
      apiBase: 'https://scanner.tradingview.com',
      ticker: 'AMEX:SPY',
      root: 'SPY',
      expiryStart: '20260626, 20260612',
      expiryEnd: '20260630',
      yahooSymbol: 'SPY'
    });

    const optionExpiries = calls
      .filter((call) => String(call.url).includes('/options/scan2'))
      .map((call) => JSON.parse(call.body).filter.find((item) => item.left === 'expiration').right);

    assert.deepEqual(optionExpiries, [20260626, 20260612]);
    assert.equal(snapshot.expiry, '20260626');
    assert.ok(snapshot.byExpiry['20260626']);
    assert.ok(snapshot.byExpiry['20260612']);
    assert.deepEqual(Object.keys(snapshot.byExpiry).sort(), ['20260612', '20260626']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('TradingViewProvider fetches resolved placeholder expiries and returns metadata', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, body: options.body || '' });
    if (String(url).includes('query1.finance.yahoo.com')) {
      return jsonResponse({
        chart: {
          result: [{
            meta: { regularMarketPrice: 100 }
          }]
        }
      });
    }
    return jsonResponse({
      fields: ['strike', 'option-type', 'bid', 'ask', 'iv', 'bid_iv', 'delta', 'gamma', 'theta', 'vega'],
      symbols: []
    });
  };

  try {
    const provider = new TradingViewProvider();
    const snapshot = await provider.fetchSnapshot({
      apiBase: 'https://scanner.tradingview.com',
      ticker: 'AMEX:SPY',
      root: 'SPY',
      expiryStart: 'today,nextWeek,nextMonth',
      expiryEnd: '',
      yahooSymbol: 'SPY',
      now: new Date('2026-09-09T12:00:00Z'),
      marketHolidays: []
    });

    const optionExpiries = calls
      .filter((call) => String(call.url).includes('/options/scan2'))
      .map((call) => JSON.parse(call.body).filter.find((item) => item.left === 'expiration').right);

    assert.deepEqual(optionExpiries, [20260909, 20260918, 20260925]);
    assert.equal(snapshot.expiry, '20260909');
    assert.deepEqual(snapshot.expiryPlaceholders, {
      today: '20260909',
      nextWeek: '20260918',
      nextMonth: '20260925'
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('TradingViewProvider resolves widget placeholder metadata without expanding literal datasource expiries', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, body: options.body || '' });
    if (String(url).includes('query1.finance.yahoo.com')) {
      return jsonResponse({
        chart: {
          result: [{
            meta: { regularMarketPrice: 100 }
          }]
        }
      });
    }
    return jsonResponse({
      fields: ['strike', 'option-type', 'bid', 'ask', 'iv', 'bid_iv', 'delta', 'gamma', 'theta', 'vega'],
      symbols: []
    });
  };

  try {
    const provider = new TradingViewProvider();
    const snapshot = await provider.fetchSnapshot({
      apiBase: 'https://scanner.tradingview.com',
      ticker: 'AMEX:SPY',
      root: 'SPY',
      expiryStart: '20260930',
      expiryEnd: '',
      yahooSymbol: 'SPY',
      expiryPlaceholderKeys: ['nextWeek'],
      now: new Date('2026-09-09T12:00:00Z'),
      marketHolidays: []
    });

    const optionExpiries = calls
      .filter((call) => String(call.url).includes('/options/scan2'))
      .map((call) => JSON.parse(call.body).filter.find((item) => item.left === 'expiration').right);

    assert.deepEqual(optionExpiries, [20260930]);
    assert.deepEqual(snapshot.expiryPlaceholders, { nextWeek: '20260918' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
