const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');
const { loadState, saveState } = require('./store.cjs');

const DEFAULT_STATE = {
  activeTabId: 'tab-1',
  tabs: [
    {
      id: 'tab-1',
      title: 'SPY Skew',
      providerKey: 'tradingview',
      providerConfig: {
        apiBase: 'https://scanner.tradingview.com',
        ticker: 'AMEX:SPY',
        root: 'SPY',
        expiry: '',
        yahooSymbol: 'SPY',
        tailSteps: 3,
        pollSec: 5,
        keepPoints: 200
      },
      widgets: [
        { id: 'w-atm-1', type: 'atm-skew-line', title: 'ATM Call-Put Skew' },
        { id: 'w-tail-1', type: 'tail-skew-line', title: '±3 Strike Put-Call Skew' }
      ]
    },
    {
      id: 'tab-2',
      title: 'nDate Put Skew',
      providerKey: 'tradingview',
      providerConfig: {
        apiBase: 'https://scanner.tradingview.com',
        ticker: 'AMEX:SPY',
        root: 'SPY',
        expiry: '',
        yahooSymbol: 'SPY',
        tailSteps: 3,
        pollSec: 5,
        keepPoints: 200
      },
      widgets: [
        {
          id: 'w-ndate-1',
          type: 'ndate-put-skew-line',
          title: 'nDate-Put-Skew',
          config: { baseStrike: 500, expiry: "", ticker: "" }
        }
      ]
    }
  ]
};

function createWindow() {
  const win = new BrowserWindow({
    width: 1300,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.loadFile(path.join(__dirname, '../renderer/index.html'));
}

app.whenReady().then(() => {
  ipcMain.handle('state:load', async () => {
    return loadState(app.getPath('userData'), DEFAULT_STATE);
  });

  ipcMain.handle('state:save', async (_evt, state) => {
    saveState(app.getPath('userData'), state);
    return { ok: true };
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
