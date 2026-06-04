const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('appBridge', {
  loadState: () => ipcRenderer.invoke('state:load'),
  saveState: (state) => ipcRenderer.invoke('state:save', state),
  loadLocalMarketSeries: (source) => ipcRenderer.invoke('market-data:load-local-series', source),
  getDailyMarketHistory: (params) => ipcRenderer.invoke('market-data:get-daily-history', params)
});
