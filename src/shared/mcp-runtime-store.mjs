export function createMcpRuntimeStore() {
  const byWidget = new Map();

  function key(tabId, widgetId) {
    return `${tabId || ''}:${widgetId || ''}`;
  }

  function set(tabId, widgetId, data) {
    if (!tabId || !widgetId) return;
    byWidget.set(key(tabId, widgetId), {
      ...data,
      tabId,
      widgetId,
      publishedAt: new Date().toISOString()
    });
  }

  function get(tabId, widgetId) {
    if (!tabId || !widgetId) return null;
    return byWidget.get(key(tabId, widgetId)) || null;
  }

  function clear(tabId, widgetId) {
    if (!tabId || !widgetId) return;
    byWidget.delete(key(tabId, widgetId));
  }

  function clearTab(tabId) {
    if (!tabId) return;
    for (const storedKey of byWidget.keys()) {
      if (storedKey.startsWith(`${tabId}:`)) byWidget.delete(storedKey);
    }
  }

  return {
    set,
    get,
    clear,
    clearTab
  };
}

export function serializeWidgetDefinition(definition) {
  if (!definition) return {};
  return {
    type: definition.type || null,
    defaultTitle: definition.defaultTitle || definition.type || null,
    mode: definition.mode || 'timeseries',
    metric: definition.metric || null,
    gridSpan: definition.gridSpan || null,
    wide: Boolean(definition.wide),
    requiresHistory: Boolean(definition.requiresHistory),
    consumesWidgetData: Boolean(definition.consumesWidgetData),
    refreshOnDashboardRefresh: definition.refreshOnDashboardRefresh,
    eventContracts: definition.eventContracts || null,
    controls: definition.controls || null,
    defaultConfig: definition.defaultConfig || null
  };
}

export function widgetRuntimeStatus(runtimeData) {
  if (!runtimeData) {
    return {
      status: 'not_loaded',
      reason: 'Widget has not published runtime data in the open UI session.'
    };
  }
  return {
    status: 'loaded',
    kind: runtimeData.kind || null,
    mode: runtimeData.mode || null,
    publishedAt: runtimeData.publishedAt || null,
    sourceSnapshotTime: runtimeData.sourceSnapshotTime || null
  };
}

export function createDashboardRuntimeSnapshot({
  state,
  widgetDefinitions,
  getRuntimeData,
  capturedAt = new Date().toISOString()
}) {
  const definitionsByType = Object.fromEntries((widgetDefinitions || []).map((definition) => [
    definition.type,
    serializeWidgetDefinition(definition)
  ]));

  return {
    mcpRuntimeVersion: 1,
    rendererReady: true,
    capturedAt,
    activeTabId: state?.activeTabId || null,
    tabs: (Array.isArray(state?.tabs) ? state.tabs : []).map((tab) => ({
      id: tab.id,
      title: tab.title || tab.id,
      providerKey: tab.providerKey || null,
      providerConfig: { ...(tab.providerConfig || {}) },
      widgets: (Array.isArray(tab.widgets) ? tab.widgets : []).map((widget) => {
        const runtimeData = getRuntimeData?.(tab.id, widget.id) || null;
        const definition = definitionsByType[widget.type] || {
          type: widget.type,
          defaultTitle: widget.type,
          mode: 'unknown'
        };
        return {
          id: widget.id,
          type: widget.type,
          title: widget.title || definition.defaultTitle || widget.type,
          config: { ...(widget.config || {}) },
          definition,
          runtimeDataStatus: widgetRuntimeStatus(runtimeData),
          runtimeData
        };
      })
    }))
  };
}

export function normalizeChartDataset(dataset, idx) {
  return {
    label: dataset?.label || `Series ${idx + 1}`,
    data: Array.isArray(dataset?.data) ? dataset.data : [],
    pointMeta: Array.isArray(dataset?.pointMeta) ? dataset.pointMeta : [],
    borderColor: dataset?.borderColor || null,
    hidden: Boolean(dataset?.hidden)
  };
}

export function createChartRuntimeData({
  widget,
  definition,
  labels,
  datasets,
  title,
  historyLength,
  sourceSnapshotTime
}) {
  return {
    kind: 'chart',
    type: widget?.type || definition?.type || null,
    title: widget?.title || definition?.defaultTitle || widget?.type || null,
    mode: definition?.mode || 'timeseries',
    config: { ...(widget?.config || {}) },
    sourceSnapshotTime: sourceSnapshotTime || null,
    historyLength: Number.isFinite(historyLength) ? historyLength : null,
    chart: {
      title: title || null,
      labels: Array.isArray(labels) ? labels : [],
      datasets: (Array.isArray(datasets) ? datasets : []).map(normalizeChartDataset)
    }
  };
}
