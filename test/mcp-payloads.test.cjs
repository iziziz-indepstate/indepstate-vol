const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildAppInfo,
  buildDashboardList,
  buildWidgetData,
  buildWidgetList,
  buildMcpPayload
} = require('../src/shared/mcp-payloads.cjs');

function sampleRuntime() {
  return {
    mcpRuntimeVersion: 1,
    rendererReady: true,
    capturedAt: '2026-06-07T12:00:00.000Z',
    activeTabId: 'tab-1',
    tabs: [
      {
        id: 'tab-1',
        title: 'SPY Skew',
        providerKey: 'tradingview',
        providerConfig: {
          ticker: 'AMEX:SPY',
          root: 'SPY',
          yahooSymbol: 'SPY',
          expiryStart: '20260607',
          pollSec: 5,
          keepPoints: 200
        },
        widgets: [
          {
            id: 'w-atm',
            type: 'atm-straddle',
            title: 'Straddle ATM',
            config: { tenor: '1W' },
            definition: { mode: 'table', requiresHistory: true },
            runtimeDataStatus: {
              status: 'loaded',
              kind: 'table',
              mode: 'table',
              publishedAt: '2026-06-07T12:00:01.000Z',
              sourceSnapshotTime: '2026-06-07T12:00:00.000Z'
            },
            runtimeData: {
              kind: 'table',
              output: {
                type: 'atm-straddle',
                status: 'ok',
                snapshot: { atmIv: 0.22, dte: 7 }
              }
            }
          },
          {
            id: 'w-tail',
            type: 'tail-skew-line',
            title: 'Tail Skew',
            config: { tailSteps: 3 },
            definition: { mode: 'timeseries-custom' },
            runtimeDataStatus: {
              status: 'not_loaded',
              reason: 'Widget has not published runtime data in the open UI session.'
            },
            runtimeData: null
          }
        ]
      }
    ]
  };
}

test('buildAppInfo describes the open dashboard runtime', () => {
  const payload = buildAppInfo(sampleRuntime());

  assert.equal(payload.app.name, 'IS-VOL');
  assert.equal(payload.activeDashboard.id, 'tab-1');
  assert.equal(payload.dashboardsCount, 1);
  assert.equal(payload.widgetsCount, 2);
  assert.equal(payload.runtime.rendererReady, true);
});

test('buildDashboardList summarizes loaded widget data by dashboard', () => {
  const payload = buildDashboardList(sampleRuntime());

  assert.equal(payload.dashboards.length, 1);
  assert.equal(payload.dashboards[0].runtimeDataAvailable, true);
  assert.equal(payload.dashboards[0].loadedWidgetsCount, 1);
  assert.equal(payload.dashboards[0].provider.ticker, 'AMEX:SPY');
});

test('buildWidgetList returns widget metadata and runtime statuses', () => {
  const payload = buildWidgetList(sampleRuntime(), 'tab-1');

  assert.equal(payload.widgets.length, 2);
  assert.equal(payload.widgets[0].runtimeDataStatus.status, 'loaded');
  assert.equal(payload.widgets[1].runtimeDataStatus.status, 'not_loaded');
});

test('buildWidgetData returns loaded runtime data without recomputation', () => {
  const payload = buildWidgetData(sampleRuntime(), 'tab-1', 'w-atm');

  assert.equal(payload.status, 'loaded');
  assert.equal(payload.data.output.snapshot.atmIv, 0.22);
});

test('buildWidgetData returns typed missing response for unloaded widget data', () => {
  const payload = buildWidgetData(sampleRuntime(), 'tab-1', 'w-tail');

  assert.equal(payload.status, 'not_loaded');
  assert.match(payload.reason, /not published runtime data/);
});

test('buildMcpPayload handles unavailable renderer runtime', () => {
  const payload = buildMcpPayload(null, 'get_app_info');

  assert.equal(payload.status, 'error');
  assert.equal(payload.error.code, 'renderer_unavailable');
});
