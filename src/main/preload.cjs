const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('appBridge', {
  loadState: () => ipcRenderer.invoke('state:load'),
  saveState: (state) => ipcRenderer.invoke('state:save', state),
  saveUiState: (uiState) => ipcRenderer.invoke('state:save-ui', uiState),
  saveRawSnapshot: (payload) => ipcRenderer.invoke('raw-snapshot:save', payload),
  loadLocalMarketSeries: (source) => ipcRenderer.invoke('market-data:load-local-series', source),
  getDailyMarketHistory: (params) => ipcRenderer.invoke('market-data:get-daily-history', params),
  getTheBlockSnapshot: (params) => ipcRenderer.invoke('theblock:get-snapshot', params),
  onMcpRuntimeStateRequest: (callback) => {
    const listener = (_evt, message) => callback(message);
    ipcRenderer.on('mcp:runtime-state-request', listener);
    return () => ipcRenderer.removeListener('mcp:runtime-state-request', listener);
  },
  sendMcpRuntimeStateResponse: (message) => ipcRenderer.send('mcp:runtime-state-response', message)
});
