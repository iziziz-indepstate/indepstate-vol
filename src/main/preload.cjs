const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('appBridge', {
  loadState: () => ipcRenderer.invoke('state:load'),
  saveState: (state) => ipcRenderer.invoke('state:save', state)
});
