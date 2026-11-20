import test from 'node:test';
import assert from 'node:assert/strict';
import { TradingViewProvider, buildExpiryList, resolveExpiryPlaceholders } from '../src/shared/tradingview-provider.js';

function jsonResponse(body) {
  return {
    json: async () => body
  };
}

test('TradingView cookie reaches all option requests, never Yahoo or snapshot data', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    return String(url).includes('query1.finance.yahoo.com')
      ? jsonResponse({ chart: { result: [{ meta: { regularMarketPrice: 100 } }] } })
      : jsonResponse({ fields: [], symbols: [] });
  };
  const config = { apiBase: 'https://scanner.tradingview.com', ticker: 'AMEX:SPY', root: 'SPY', expiryStart: '20261120,20261127' };
  const cookie = 'sessionid=test-session; sessionid_sign=test-signature';
  const snapshot = await new TradingViewProvider({ cookie }).fetchSnapshot(config);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].options.headers?.cookie, undefined);
  for (const { options } of calls.slice(1)) {
    assert.equal(options.headers.cookie, cookie);
    assert.equal(options.redirect, 'error');
  }
  assert.ok(!JSON.stringify(snapshot).includes('test-session'));
  calls.length = 0;
  await new TradingViewProvider().fetchSnapshot(config);
  for (const { options } of calls) assert.equal(options.headers?.cookie, undefined);

  calls.length = 0;
  await assert.rejects(new TradingViewProvider({ cookie }).fetchSnapshot({ ...config, apiBase: 'https://other.example' }), /session cookies require/);
  assert.equal(calls.length, 1);
  assert.ok(String(calls[0].url).includes('query1.finance.yahoo.com'));
});

test('TradingViewProvider checks modes across every requested expiry and handles missing metadata', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let secondExpiryModes = ['delayed_streaming_900'];
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes('query1.finance.yahoo.com')) {
      return jsonResponse({ chart: { result: [{ meta: { regularMarketPrice: 100 } }] } });
    }
    const body = JSON.parse(options.body);
    assert.ok(body.columns.includes('update_mode'));
    const expiry = body.filter.find((item) => item.left === 'expiration').right;
    const modes = expiry === 20261120 ? ['streaming'] : secondExpiryModes;
    return jsonResponse({ fields: ['strike', 'option-type', 'update_mode'], symbols: modes.map((mode) => ({ f: [100, 'call', mode] })) });
  };
  const config = { apiBase: 'https://scanner.tradingview.com', ticker: 'AMEX:SPY', root: 'SPY', expiryStart: '20261120,20261127' };
  const provider = new TradingViewProvider();
  assert.equal((await provider.fetchSnapshot(config)).marketData.status, 'delayed');
  secondExpiryModes = ['streaming'];
  assert.equal((await provider.fetchSnapshot(config)).marketData.status, 'realtime');
  secondExpiryModes = [];
  assert.equal((await provider.fetchSnapshot(config)).marketData.status, 'unknown');
  secondExpiryModes = [null];
  assert.equal((await provider.fetchSnapshot(config)).marketData.status, 'unknown');
});

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
    { today: '20260909', tomorrow: '20260910', nextWeek: '20260918', nextMonth: '20260925' }
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
    { today: '20260917', tomorrow: '20260918', nextWeek: '20260925', nextMonth: '20261030' }
  );
});

test('buildExpiryList resolves mixed placeholders in user order', () => {
  assert.deepEqual(
    buildExpiryList('today, 20260930,tomorrow,nextWeek,nextMonth', '', {
      now: new Date('2026-09-09T12:00:00Z'),
      marketHolidays: []
    }),
    ['20260909', '20260930', '20260910', '20260918', '20260925']
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
      expiryStart: 'today,tomorrow,nextWeek,nextMonth',
      expiryEnd: '',
      yahooSymbol: 'SPY',
      now: new Date('2026-09-09T12:00:00Z'),
      marketHolidays: []
    });

    const optionExpiries = calls
      .filter((call) => String(call.url).includes('/options/scan2'))
      .map((call) => JSON.parse(call.body).filter.find((item) => item.left === 'expiration').right);

    assert.deepEqual(optionExpiries, [20260909, 20260910, 20260918, 20260925]);
    assert.equal(snapshot.expiry, '20260909');
    assert.deepEqual(snapshot.expiryPlaceholders, {
      today: '20260909',
      tomorrow: '20260910',
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
      expiryPlaceholderKeys: ['tomorrow', 'nextWeek'],
      now: new Date('2026-09-09T12:00:00Z'),
      marketHolidays: []
    });

    const optionExpiries = calls
      .filter((call) => String(call.url).includes('/options/scan2'))
      .map((call) => JSON.parse(call.body).filter.find((item) => item.left === 'expiration').right);

    assert.deepEqual(optionExpiries, [20260930]);
    assert.deepEqual(snapshot.expiryPlaceholders, { tomorrow: '20260910', nextWeek: '20260918' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
