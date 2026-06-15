import test from 'node:test';
import assert from 'node:assert/strict';
import { TradingViewProvider, buildExpiryList } from '../src/shared/tradingview-provider.js';

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
    const provider = new TradingViewProvider();
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
