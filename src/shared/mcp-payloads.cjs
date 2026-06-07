const APP_NAME = 'IS-VOL';
const APP_PURPOSE = 'Electron dashboard for monitoring volatility analytics and broader market state.';
const DATA_SEMANTICS = [
  'MCP exposes the data already loaded in the open UI runtime.',
  'MCP tools never trigger market-data refreshes, widget recomputation outside the UI, or tab switching.',
  'Widgets can be unavailable when their tab has not been opened/rendered in the current UI session.'
];

function cloneJson(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function findTab(runtime, tabId) {
  return safeArray(runtime?.tabs).find((tab) => tab?.id === tabId) || null;
}

function findWidget(tab, widgetId) {
  return safeArray(tab?.widgets).find((widget) => widget?.id === widgetId) || null;
}

function runtimeSummary(runtime) {
  return {
    capturedAt: runtime?.capturedAt || null,
    activeTabId: runtime?.activeTabId || null,
    rendererReady: Boolean(runtime?.rendererReady),
    mcpRuntimeVersion: runtime?.mcpRuntimeVersion || 1
  };
}

function dataStatusFromWidget(widget) {
  return widget?.runtimeDataStatus || {
    status: 'not_loaded',
    reason: 'Widget has not published runtime data in the open UI session.'
  };
}

function providerSummary(tab) {
  const cfg = tab?.providerConfig || {};
  return {
    providerKey: tab?.providerKey || null,
    ticker: cfg.ticker || null,
    root: cfg.root || null,
    yahooSymbol: cfg.yahooSymbol || null,
    expiryStart: cfg.expiryStart || cfg.expiry || null,
    expiryEnd: cfg.expiryEnd || null,
    pollSec: cfg.pollSec ?? null,
    keepPoints: cfg.keepPoints ?? null
  };
}

function buildAppInfo(runtime) {
  const activeTab = findTab(runtime, runtime?.activeTabId);
  return {
    app: {
      name: APP_NAME,
      purpose: APP_PURPOSE,
      product: 'Open UI dashboard MCP proxy'
    },
    dataSemantics: DATA_SEMANTICS,
    activeDashboard: activeTab
      ? { id: activeTab.id, title: activeTab.title }
      : null,
    dashboardsCount: safeArray(runtime?.tabs).length,
    widgetsCount: safeArray(runtime?.tabs).reduce((sum, tab) => sum + safeArray(tab?.widgets).length, 0),
    runtime: runtimeSummary(runtime)
  };
}

function buildDashboardList(runtime) {
  return {
    runtime: runtimeSummary(runtime),
    dashboards: safeArray(runtime?.tabs).map((tab) => {
      const widgets = safeArray(tab?.widgets);
      return {
        id: tab.id,
        title: tab.title || tab.id,
        active: tab.id === runtime?.activeTabId,
        provider: providerSummary(tab),
        widgetsCount: widgets.length,
        runtimeDataAvailable: widgets.some((widget) => dataStatusFromWidget(widget).status === 'loaded'),
        loadedWidgetsCount: widgets.filter((widget) => dataStatusFromWidget(widget).status === 'loaded').length
      };
    })
  };
}

function buildWidgetList(runtime, tabId) {
  const tab = findTab(runtime, tabId);
  if (!tab) {
    return {
      runtime: runtimeSummary(runtime),
      error: {
        code: 'dashboard_not_found',
        message: `Dashboard not found: ${tabId}`
      },
      widgets: []
    };
  }

  return {
    runtime: runtimeSummary(runtime),
    dashboard: {
      id: tab.id,
      title: tab.title || tab.id,
      active: tab.id === runtime?.activeTabId,
      provider: providerSummary(tab)
    },
    widgets: safeArray(tab.widgets).map((widget) => ({
      id: widget.id,
      type: widget.type,
      title: widget.title || widget.defaultTitle || widget.type,
      config: cloneJson(widget.config || {}),
      definition: cloneJson(widget.definition || {}),
      runtimeDataStatus: dataStatusFromWidget(widget)
    }))
  };
}

function buildWidgetData(runtime, tabId, widgetId) {
  const tab = findTab(runtime, tabId);
  if (!tab) {
    return {
      runtime: runtimeSummary(runtime),
      status: 'error',
      error: {
        code: 'dashboard_not_found',
        message: `Dashboard not found: ${tabId}`
      }
    };
  }

  const widget = findWidget(tab, widgetId);
  if (!widget) {
    return {
      runtime: runtimeSummary(runtime),
      dashboard: { id: tab.id, title: tab.title || tab.id },
      status: 'error',
      error: {
        code: 'widget_not_found',
        message: `Widget not found: ${widgetId}`
      }
    };
  }

  const runtimeData = widget.runtimeData || null;
  const runtimeDataStatus = dataStatusFromWidget(widget);
  if (!runtimeData || runtimeDataStatus.status !== 'loaded') {
    return {
      runtime: runtimeSummary(runtime),
      dashboard: { id: tab.id, title: tab.title || tab.id },
      widget: {
        id: widget.id,
        type: widget.type,
        title: widget.title || widget.defaultTitle || widget.type,
        config: cloneJson(widget.config || {}),
        definition: cloneJson(widget.definition || {})
      },
      status: runtimeDataStatus.status,
      reason: runtimeDataStatus.reason || 'Widget data is not loaded in the open UI runtime.'
    };
  }

  return {
    runtime: runtimeSummary(runtime),
    dashboard: { id: tab.id, title: tab.title || tab.id },
    widget: {
      id: widget.id,
      type: widget.type,
      title: widget.title || widget.defaultTitle || widget.type,
      config: cloneJson(widget.config || {}),
      definition: cloneJson(widget.definition || {})
    },
    status: 'loaded',
    data: cloneJson(runtimeData)
  };
}

function buildMcpPayload(runtime, toolName, args = {}) {
  if (!runtime || typeof runtime !== 'object') {
    return {
      status: 'error',
      error: {
        code: 'renderer_unavailable',
        message: 'Open UI runtime is unavailable.'
      }
    };
  }

  if (toolName === 'get_app_info') return buildAppInfo(runtime);
  if (toolName === 'list_dashboards') return buildDashboardList(runtime);
  if (toolName === 'list_widgets') return buildWidgetList(runtime, args.tabId);
  if (toolName === 'get_widget_data') return buildWidgetData(runtime, args.tabId, args.widgetId);

  return {
    status: 'error',
    error: {
      code: 'unknown_tool',
      message: `Unknown MCP payload tool: ${toolName}`
    }
  };
}

module.exports = {
  APP_NAME,
  APP_PURPOSE,
  DATA_SEMANTICS,
  buildAppInfo,
  buildDashboardList,
  buildWidgetList,
  buildWidgetData,
  buildMcpPayload
};
