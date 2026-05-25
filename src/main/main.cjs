const path = require('path');
const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const { loadState, saveState } = require('./store.cjs');
const { startAutoUpdater } = require('./auto-updater.cjs');

app.setName('IS-VOL');

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
        expiryStart: '',
        expiryEnd: '',
        yahooSymbol: 'SPY',
        pollSec: 5,
        keepPoints: 200
      },
      widgets: [
        { id: 'w-atm-1', type: 'atm-skew-line', title: 'ATM Call-Put Skew' },
        { id: 'w-tail-1', type: 'tail-skew-line', title: 'Tail Put-Call Skew', config: { tailSteps: 3 } }
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
        expiryStart: '',
        expiryEnd: '',
        yahooSymbol: 'SPY',
        pollSec: 5,
        keepPoints: 200
      },
      widgets: [
        {
          id: 'w-ndate-1',
          type: 'ndate-skew-velocity-put-line',
          title: 'nDate-Skew-Velocity-Put',
          config: { baseStrike: 500, expiryStart: '', expiryEnd: '' }
        },
        {
          id: 'w-ndate-call-1',
          type: 'ndate-skew-velocity-call-line',
          title: 'nDate-Skew-Velocity-Call',
          config: { baseStrike: 500, expiryStart: '', expiryEnd: '' }
        }
      ]
    }
  ],
  historyByTab: {}
};

function createWindow() {
  const win = new BrowserWindow({
    title: 'IS-VOL',
    width: 1300,
    height: 900,
    icon: path.join(__dirname, '../../assets/app.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.loadFile(path.join(__dirname, '../renderer/index.html'));
  win.on('page-title-updated', (event) => {
    event.preventDefault();
  });
}

app.whenReady().then(() => {
  startAutoUpdater();
  Menu.setApplicationMenu(null);

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
