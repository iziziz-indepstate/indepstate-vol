const path = require('path');
const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const { loadState, saveUiState } = require('./store.cjs');
const { loadLocalMarketSeries } = require('./local-market-data.cjs');
const { createMarketDataService } = require('./market-data-providers.cjs');
const { startAutoUpdater } = require('./auto-updater.cjs');
const { startMcpServer } = require('./mcp-server.cjs');
const { defaultRawSnapshotDir, saveRawSnapshotAsync } = require('./raw-snapshot-store.cjs');
const profiler = require('./profiler.cjs');

app.setName('IS-VOL');

let mainWindow = null;
let mcpServer = null;
let persistedState = null;
let scheduledStateSaveTimer = null;
let scheduledStateSavePromise = Promise.resolve();

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

function profilerEnabledFromLaunch() {
  const argv = process.argv.map((arg) => String(arg).toLowerCase());
  const env = String(process.env.IS_VOL_PROFILER || '').toLowerCase();
  return argv.includes('--profile')
    || argv.includes('--profiler')
    || argv.includes('--is-vol-profiler')
    || ['1', 'true', 'yes', 'on'].includes(env);
}

function savePersistedStateNow(detail = {}) {
  if (!persistedState) return Promise.resolve();
  return profiler.measure('state:save-scheduled', detail, () => saveUiState(app.getPath('userData'), persistedState));
}

function cancelScheduledStateSave() {
  if (!scheduledStateSaveTimer) return;
  clearTimeout(scheduledStateSaveTimer);
  scheduledStateSaveTimer = null;
}

function schedulePersistedStateSave(detail = {}, delayMs = 2500) {
  const effectiveDelayMs = Math.max(60000, Number(delayMs) || 0);
  if (scheduledStateSaveTimer) return;
  scheduledStateSaveTimer = setTimeout(() => {
    scheduledStateSaveTimer = null;
    scheduledStateSavePromise = savePersistedStateNow(detail)
      .catch((err) => console.warn('Failed to save scheduled state', err));
  }, effectiveDelayMs);
}

async function flushScheduledStateSave() {
  if (scheduledStateSaveTimer) {
    clearTimeout(scheduledStateSaveTimer);
    scheduledStateSaveTimer = null;
    await savePersistedStateNow({ reason: 'flush' });
  }
  await scheduledStateSavePromise;
}

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
  profiler.setEnabled(profilerEnabledFromLaunch());
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
    const current = persistedState || loadState(app.getPath('userData'), DEFAULT_STATE);
    persistedState = {
      ...current,
      activeTabId: state?.activeTabId || current.activeTabId,
      tabs: Array.isArray(state?.tabs) ? state.tabs : current.tabs,
      historyByTab: state?.historyByTab && typeof state.historyByTab === 'object'
        ? state.historyByTab
        : (current.historyByTab || {})
    };
    cancelScheduledStateSave();
    await profiler.measure('state:save', {
      tabs: Array.isArray(persistedState?.tabs) ? persistedState.tabs.length : 0
    }, () => saveUiState(app.getPath('userData'), persistedState));
    return { ok: true };
  });

  ipcMain.handle('state:save-ui', async (_evt, uiState) => {
    const current = persistedState || loadState(app.getPath('userData'), DEFAULT_STATE);
    persistedState = {
      ...current,
      activeTabId: uiState?.activeTabId || current.activeTabId,
      tabs: Array.isArray(uiState?.tabs) ? uiState.tabs : current.tabs
    };
    cancelScheduledStateSave();
    await profiler.measure('state:save-ui', {
      tabs: Array.isArray(persistedState?.tabs) ? persistedState.tabs.length : 0
    }, () => saveUiState(app.getPath('userData'), persistedState));
    return { ok: true };
  });

  ipcMain.handle('state:append-history-point', async (_evt, payload) => {
    const tabId = payload?.tabId;
    if (!tabId) return { ok: false, error: 'tabId is required' };
    const current = persistedState || loadState(app.getPath('userData'), DEFAULT_STATE);
    const historyByTab = {
      ...(current.historyByTab || {})
    };
    const rows = Array.isArray(historyByTab[tabId]) ? [...historyByTab[tabId]] : [];
    rows.push(payload.point);
    const keep = Math.max(20, Number(payload.keep) || 200);
    while (rows.length > keep) rows.shift();
    historyByTab[tabId] = rows;
    persistedState = {
      ...current,
      historyByTab
    };
    profiler.push({
      name: 'state:append-history-point',
      detail: {
        tabId,
        keep,
        history: rows.length
      },
      durationMs: 0
    });
    return { ok: true, history: rows.length };
  });

  ipcMain.handle('raw-snapshot:save', async (_evt, payload) => {
    return profiler.measure('raw-snapshot:save', {
      tabId: payload?.tab?.id,
      providerKey: payload?.tab?.providerKey
    }, () => saveRawSnapshotAsync(defaultRawSnapshotDir(app), payload || {}));
  });

  ipcMain.handle('market-data:load-local-series', async (_evt, source) => {
    return loadLocalMarketSeries(source);
  });

  ipcMain.handle('market-data:get-daily-history', async (_evt, params) => {
    return profiler.measure('market-data:get-daily-history', {
      symbol: params?.symbol,
      provider: params?.provider,
      dataMode: params?.dataMode
    }, () => marketDataService.getDailyHistory(params || {}));
  });

  ipcMain.handle('tradingview:get-snapshot', async (_evt, params) => {
    const { TradingViewProvider } = await import('../shared/tradingview-provider.js');
    const provider = new TradingViewProvider();
    return profiler.measure('tradingview:get-snapshot', {
      ticker: params?.ticker,
      root: params?.root,
      expiryStart: params?.expiryStart || params?.expiry,
      expiryEnd: params?.expiryEnd
    }, () => provider.fetchSnapshot(params || {}, SKEW_METRICS));
  });

  ipcMain.handle('theblock:get-snapshot', async (_evt, params) => {
    const { TheBlockProvider } = await import('../shared/theblock-provider.js');
    const provider = new TheBlockProvider();
    return profiler.measure('theblock:get-snapshot', {
      chartIds: Array.isArray(params?.chartIds) ? params.chartIds.length : null
    }, () => provider.fetchSnapshot(params || {}));
  });

  ipcMain.handle('profiler:export', async (_evt, rendererEvents) => {
    return profiler.exportEvents(app.getPath('userData'), rendererEvents || []);
  });

  ipcMain.handle('profiler:is-enabled', async () => profiler.isEnabled());

  createWindow();
  mcpServer = startMcpServer({
    getWindow: () => mainWindow
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', (event) => {
  if (scheduledStateSaveTimer) {
    event.preventDefault();
    flushScheduledStateSave()
      .finally(() => app.quit());
    return;
  }
  if (mcpServer) {
    mcpServer.close().catch(() => {});
    mcpServer = null;
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
