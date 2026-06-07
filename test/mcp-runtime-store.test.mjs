import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createChartRuntimeData,
  createDashboardRuntimeSnapshot,
  createMcpRuntimeStore
} from '../src/shared/mcp-runtime-store.mjs';

test('runtime store keeps and clears widget data by tab/widget id', () => {
  const store = createMcpRuntimeStore();
  store.set('tab-1', 'w-1', { kind: 'chart', chart: { labels: ['a'], datasets: [] } });

  assert.equal(store.get('tab-1', 'w-1').kind, 'chart');

  store.clear('tab-1', 'w-1');
  assert.equal(store.get('tab-1', 'w-1'), null);
});

test('runtime store clears all widgets for a removed tab', () => {
  const store = createMcpRuntimeStore();
  store.set('tab-1', 'w-1', { kind: 'chart' });
  store.set('tab-1', 'w-2', { kind: 'table' });
  store.set('tab-2', 'w-3', { kind: 'chart' });

  store.clearTab('tab-1');

  assert.equal(store.get('tab-1', 'w-1'), null);
  assert.equal(store.get('tab-1', 'w-2'), null);
  assert.equal(store.get('tab-2', 'w-3').kind, 'chart');
});

test('dashboard runtime snapshot marks loaded and not-loaded widgets', () => {
  const store = createMcpRuntimeStore();
  store.set('tab-1', 'w-loaded', {
    kind: 'chart',
    mode: 'timeseries',
    sourceSnapshotTime: '2026-06-07T12:00:00.000Z'
  });

  const snapshot = createDashboardRuntimeSnapshot({
    capturedAt: '2026-06-07T12:00:01.000Z',
    state: {
      activeTabId: 'tab-1',
      tabs: [
        {
          id: 'tab-1',
          title: 'SPY',
          providerKey: 'tradingview',
          providerConfig: { ticker: 'AMEX:SPY' },
          widgets: [
            { id: 'w-loaded', type: 'atm-skew-line', title: 'ATM', config: {} },
            { id: 'w-empty', type: 'tail-skew-line', title: 'Tail', config: {} }
          ]
        }
      ]
    },
    widgetDefinitions: [
      { type: 'atm-skew-line', mode: 'timeseries', defaultTitle: 'ATM Call-Put Skew' },
      { type: 'tail-skew-line', mode: 'timeseries-custom', defaultTitle: 'Tail Put-Call Skew' }
    ],
    getRuntimeData: (tabId, widgetId) => store.get(tabId, widgetId)
  });

  assert.equal(snapshot.tabs[0].widgets[0].runtimeDataStatus.status, 'loaded');
  assert.equal(snapshot.tabs[0].widgets[1].runtimeDataStatus.status, 'not_loaded');
  assert.equal(snapshot.tabs[0].widgets[0].definition.mode, 'timeseries');
});

test('chart runtime data serializes labels, datasets, and point metadata', () => {
  const data = createChartRuntimeData({
    widget: { type: 'n-delta-iv', title: 'nD', config: { targetDelta: 0.25 } },
    definition: { mode: 'timeseries-custom' },
    labels: ['10:00'],
    datasets: [
      {
        label: 'PUT 25D IV',
        data: [0.24],
        pointMeta: [{ matchedStrike: 5000 }],
        borderColor: '#38bdf8'
      }
    ],
    title: 'n-Delta IV',
    historyLength: 1,
    sourceSnapshotTime: '2026-06-07T12:00:00.000Z'
  });

  assert.equal(data.kind, 'chart');
  assert.equal(data.chart.title, 'n-Delta IV');
  assert.equal(data.chart.datasets[0].pointMeta[0].matchedStrike, 5000);
  assert.equal(data.config.targetDelta, 0.25);
});
