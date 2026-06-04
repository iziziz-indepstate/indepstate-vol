const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMarketDataService, normalizeBars } = require('../src/main/market-data-providers.cjs');

function response(body, { status = 200, json = false } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => String(body),
    json: async () => (json ? body : JSON.parse(body))
  };
}

test('normalizes provider-specific columns, removes invalid rows and deduplicates dates', () => {
  assert.deepEqual(normalizeBars([
    { DATE: '2026-06-02', Last: '15.5' },
    { Date: '2026-06-02', Close: '15.6' },
    { DATE: '06/03/2026', CLOSE: '16.1' },
    { date: '2026-06-03', close: '-1' }
  ], 'VIX', 'test'), [{
    date: '2026-06-02',
    symbol: 'VIX',
    open: undefined,
    high: undefined,
    low: undefined,
    close: 15.6,
    source: 'test',
    updated_at: undefined
  }, {
    date: '2026-06-03',
    symbol: 'VIX',
    open: undefined,
    high: undefined,
    low: undefined,
    close: 16.1,
    source: 'test',
    updated_at: undefined
  }]);
});

test('loads FRED series and maps its series-id column to close', async () => {
  const service = createMarketDataService({
    cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), 'is-vol-cache-')),
    fetchImpl: async (url) => {
      assert.match(url, /id=SP500/);
      return response('observation_date,SP500\n2026-06-01,6000.5\n');
    }
  });

  const result = await service.getDailyHistory({
    dataMode: 'remote',
    provider: 'fred',
    fallbackProviders: [],
    symbol: 'SPX',
    cache: false
  });
  assert.equal(result.provider, 'fred');
  assert.equal(result.bars[0].close, 6000.5);
  assert.equal(result.bars[0].symbol, 'SPX');
});

test('falls back from unavailable Cboe to Yahoo and reports actual provider', async () => {
  const service = createMarketDataService({
    cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), 'is-vol-cache-')),
    fetchImpl: async (url) => {
      if (url.includes('cdn.cboe.com')) return response('', { status: 503 });
      return response({
        chart: {
          result: [{
            timestamp: [1780358400],
            indicators: { quote: [{ close: [13.2], open: [13], high: [14], low: [12] }] }
          }]
        }
      }, { json: true });
    }
  });

  const result = await service.getDailyHistory({
    dataMode: 'remote',
    provider: 'cboe',
    fallbackProviders: ['yahoo'],
    symbol: 'VIX9D',
    cache: false
  });
  assert.equal(result.provider, 'yahoo');
  assert.equal(result.fallback, true);
  assert.equal(result.bars[0].close, 13.2);
});

test('hybrid mode uses stale cache when remote refresh fails', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'is-vol-cache-'));
  fs.writeFileSync(path.join(cacheDir, 'fred-SPX.json'), JSON.stringify({
    provider: 'fred',
    symbol: 'SPX',
    updatedAt: '2020-01-01T00:00:00.000Z',
    bars: [{ date: '2026-06-01', symbol: 'SPX', close: 6000, source: 'fred' }]
  }));
  const service = createMarketDataService({
    cacheDir,
    fetchImpl: async () => response('', { status: 503 })
  });

  const result = await service.getDailyHistory({
    dataMode: 'hybrid',
    provider: 'fred',
    fallbackProviders: [],
    symbol: 'SPX',
    cache: true,
    forceRefresh: true
  });
  assert.equal(result.cached, true);
  assert.equal(result.cacheFresh, false);
  assert.match(result.warning, /stale cache/i);
});

test('force refresh bypasses fresh cache and replaces it with remote data', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'is-vol-cache-'));
  fs.writeFileSync(path.join(cacheDir, 'fred-SPX.json'), JSON.stringify({
    provider: 'fred',
    symbol: 'SPX',
    updatedAt: new Date().toISOString(),
    bars: [{ date: '2026-06-01', symbol: 'SPX', close: 5000, source: 'fred' }]
  }));
  const service = createMarketDataService({
    cacheDir,
    fetchImpl: async () => response('observation_date,SP500\n2026-06-01,6000\n')
  });

  const result = await service.getDailyHistory({
    dataMode: 'remote',
    provider: 'fred',
    fallbackProviders: [],
    symbol: 'SPX',
    cache: true,
    forceRefresh: true
  });
  assert.equal(result.cached, false);
  assert.equal(result.bars[0].close, 6000);
});
