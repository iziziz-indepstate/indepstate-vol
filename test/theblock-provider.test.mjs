import test from 'node:test';
import assert from 'node:assert/strict';
import {
  THE_BLOCK_CHARTS,
  TheBlockProvider,
  normalizeTheBlockChart
} from '../src/shared/theblock-provider.js';

test('normalizes The Block dashboard JSON series', () => {
  const chart = normalizeTheBlockChart({
    Description: 'BTC ATM Implied Volatility',
    Frequency: 'Daily',
    Source: 'Other',
    Series: {
      '1 week': {
        Type: 'line',
        YAxis: 'number',
        YAxisFormat: 'percent',
        Data: [
          { Timestamp: 1780272000, Result: 41.5 },
          { Timestamp: 1780185600, Result: 40.25 },
          { Timestamp: null, Result: 99 }
        ]
      }
    }
  }, THE_BLOCK_CHARTS.btcAtmImpliedVolatility);

  assert.equal(chart.id, 'btcAtmImpliedVolatility');
  assert.equal(chart.title, 'BTC ATM Implied Volatility');
  assert.equal(chart.frequency, 'Daily');
  assert.deepEqual(chart.series['1 week'].points, [
    { timestamp: 1780185600, date: '2026-05-31', value: 40.25 },
    { timestamp: 1780272000, date: '2026-06-01', value: 41.5 }
  ]);
});

test('TheBlockProvider loads configured charts into a snapshot', async () => {
  const provider = new TheBlockProvider({
    fetchImpl: async (url) => {
      assert.equal(url, THE_BLOCK_CHARTS.btcDvolVolOfVol.url);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          Description: 'BTC DVol Vol of  Vol',
          Frequency: 'Daily',
          Series: {
            'Vol of Vol': { Data: [{ Timestamp: 1780358400, Result: 92 }] },
            'DVol Index': { Data: [{ Timestamp: 1780358400, Result: 40 }] }
          }
        })
      };
    }
  });

  const snapshot = await provider.fetchSnapshot({ chartIds: ['btcDvolVolOfVol'] });
  assert.equal(snapshot.provider, 'theblock');
  assert.equal(snapshot.theBlock.latestDate, '2026-06-02');
  assert.deepEqual(Object.keys(snapshot.theBlock.charts), ['btcDvolVolOfVol']);
  assert.equal(snapshot.theBlock.charts.btcDvolVolOfVol.series['Vol of Vol'].points[0].value, 92);
});
