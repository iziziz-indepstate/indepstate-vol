const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('appBridge', {
  loadState: () => ipcRenderer.invoke('state:load'),
  saveState: (state) => ipcRenderer.invoke('state:save', state),
  saveUiState: (uiState) => ipcRenderer.invoke('state:save-ui', uiState),
  appendHistoryPoint: (payload) => ipcRenderer.invoke('state:append-history-point', payload),
  saveRawSnapshot: (payload) => ipcRenderer.invoke('raw-snapshot:save', payload),
  saveAtmStraddleSnapshot: (payload) => ipcRenderer.invoke('atm-straddle-snapshot:save', payload),
  loadAtmStraddleSnapshots: (params) => ipcRenderer.invoke('atm-straddle-snapshot:load', params),
  loadLocalMarketSeries: (source) => ipcRenderer.invoke('market-data:load-local-series', source),
  getDailyMarketHistory: (params) => ipcRenderer.invoke('market-data:get-daily-history', params),
  getTradingViewSnapshot: (params) => ipcRenderer.invoke('tradingview:get-snapshot', params),
  getTheBlockSnapshot: (params) => ipcRenderer.invoke('theblock:get-snapshot', params),
  syncDataSources: (payload) => ipcRenderer.invoke('datasource:sync-tabs', payload),
  runDataSourceCommand: (payload) => ipcRenderer.invoke('datasource:command', payload),
  getDataSourceLifecycleUi: () => ipcRenderer.invoke('datasource:lifecycle-ui'),
  updateDataSourceLifecycleSettings: (payload) => ipcRenderer.invoke('datasource:update-lifecycle-settings', payload),
  onDataSourceCommand: (callback) => {
    const listener = (_evt, message) => callback(message);
    ipcRenderer.on('datasource:command', listener);
    return () => ipcRenderer.removeListener('datasource:command', listener);
  },
  sendDataSourceCommandResult: (message) => ipcRenderer.send('datasource:command-result', message),
  onDataSourceConfigPatch: (callback) => {
    const listener = (_evt, message) => callback(message);
    ipcRenderer.on('datasource:config-patch', listener);
    return () => ipcRenderer.removeListener('datasource:config-patch', listener);
  },
  onDataSourceLifecycleUiUpdated: (callback) => {
    const listener = (_evt, message) => callback(message);
    ipcRenderer.on('datasource:lifecycle-ui-updated', listener);
    return () => ipcRenderer.removeListener('datasource:lifecycle-ui-updated', listener);
  },
  isProfilerEnabled: () => ipcRenderer.invoke('profiler:is-enabled'),
  exportProfilerEvents: (events) => ipcRenderer.invoke('profiler:export', events),
  onMcpRuntimeStateRequest: (callback) => {
    const listener = (_evt, message) => callback(message);
    ipcRenderer.on('mcp:runtime-state-request', listener);
    return () => ipcRenderer.removeListener('mcp:runtime-state-request', listener);
  },
  sendMcpRuntimeStateResponse: (message) => ipcRenderer.send('mcp:runtime-state-response', message)
});
