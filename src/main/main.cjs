const path = require('path');
const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const { loadState, saveState } = require('./store.cjs');
const { loadLocalMarketSeries } = require('./local-market-data.cjs');
const { createMarketDataService } = require('./market-data-providers.cjs');
const { startAutoUpdater } = require('./auto-updater.cjs');
const { startMcpServer } = require('./mcp-server.cjs');
const { defaultRawSnapshotDir, saveRawSnapshotAsync } = require('./raw-snapshot-store.cjs');

app.setName('IS-VOL');

let mainWindow = null;
let mcpServer = null;
let persistedState = null;

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

const SKEW_METRICS = [
  {
    key: 'dAtm',
    compute: ({ atmPutIv, atmCallIv }) => {
      if (atmPutIv == null || atmCallIv == null) return null;
      return atmCallIv - atmPutIv;
    }
  }
];

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
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  mainWindow = win;
}

app.whenReady().then(() => {
  startAutoUpdater();
  Menu.setApplicationMenu(null);
  const marketDataService = createMarketDataService({
    cacheDir: path.join(app.getPath('userData'), 'market-data-cache')
  });

  ipcMain.handle('state:load', async () => {
    persistedState = loadState(app.getPath('userData'), DEFAULT_STATE);
    return persistedState;
  });

  ipcMain.handle('state:save', async (_evt, state) => {
    persistedState = state;
    await saveState(app.getPath('userData'), persistedState);
    return { ok: true };
  });

  ipcMain.handle('state:save-ui', async (_evt, uiState) => {
    const current = persistedState || loadState(app.getPath('userData'), DEFAULT_STATE);
    persistedState = {
      ...current,
      activeTabId: uiState?.activeTabId || current.activeTabId,
      tabs: Array.isArray(uiState?.tabs) ? uiState.tabs : current.tabs
    };
    await saveState(app.getPath('userData'), persistedState);
    return { ok: true };
  });

  ipcMain.handle('raw-snapshot:save', async (_evt, payload) => {
    return saveRawSnapshotAsync(defaultRawSnapshotDir(app), payload || {});
  });

  ipcMain.handle('market-data:load-local-series', async (_evt, source) => {
    return loadLocalMarketSeries(source);
  });

  ipcMain.handle('market-data:get-daily-history', async (_evt, params) => {
    return marketDataService.getDailyHistory(params || {});
  });

  ipcMain.handle('tradingview:get-snapshot', async (_evt, params) => {
    const { TradingViewProvider } = await import('../shared/tradingview-provider.js');
    const provider = new TradingViewProvider();
    return provider.fetchSnapshot(params || {}, SKEW_METRICS);
  });

  ipcMain.handle('theblock:get-snapshot', async (_evt, params) => {
    const { TheBlockProvider } = await import('../shared/theblock-provider.js');
    const provider = new TheBlockProvider();
    return provider.fetchSnapshot(params || {});
  });

  createWindow();
  mcpServer = startMcpServer({
    getWindow: () => mainWindow
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  if (mcpServer) {
    mcpServer.close().catch(() => {});
    mcpServer = null;
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
