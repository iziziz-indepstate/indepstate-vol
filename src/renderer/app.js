import { TradingViewProvider } from '../shared/tradingview-provider.js';
import { getWidgetDefinition } from './widgets/index.js';
import { createWidgetCard, createWidgetChart } from './widgets/widget-renderers.js';
import { skewMetrics } from './widgets/metrics.js';

const providers = {
  tradingview: new TradingViewProvider()
};

const state = {
  activeTabId: null,
  tabs: [],
  historyByTab: {}
};

let timer = null;
const chartInstances = new Map();
let tabContextTargetId = null;

const $ = (id) => document.getElementById(id);

function activeTab() {
  return state.tabs.find((t) => t.id === state.activeTabId);
}

function defaultExpiry() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}


function parseWidgetTicker(value) {
  const ticker = String(value || '').trim();
  if (!ticker) return { ticker: null, root: null };

  const root = ticker.includes(':') ? ticker.split(':').pop()?.trim() : ticker;
  if (!root) return { ticker: null, root: null };

  return { ticker, root };
}

function parseExpiryDate(value) {
  const raw = String(value || '').trim();
  if (!/^\d{8}$/.test(raw)) return null;

  const y = Number(raw.slice(0, 4));
  const m = Number(raw.slice(4, 6));
  const d = Number(raw.slice(6, 8));
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt;
}

function fmtExpiryDate(dt) {
  return [
    dt.getUTCFullYear(),
    String(dt.getUTCMonth() + 1).padStart(2, '0'),
    String(dt.getUTCDate()).padStart(2, '0')
  ].join('');
}

function expandExpiryRange(startValue, endValue) {
  const start = parseExpiryDate(startValue);
  if (!start) return [];

  const parsedEnd = parseExpiryDate(endValue);
  const end = parsedEnd && parsedEnd >= start ? parsedEnd : start;
  const out = [];
  let cursor = new Date(start);
  while (cursor <= end) {
    out.push(fmtExpiryDate(cursor));
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
  }
  return out;
}

function setStatus(text) {
  $('globalStatus').textContent = text;
}

function persist() {
  window.appBridge.saveState({
    activeTabId: state.activeTabId,
    tabs: state.tabs
  });
}

function applyTabToForm(tab) {
  $('providerKey').value = tab.providerKey;
  $('apiBase').value = tab.providerConfig.apiBase || '';
  $('ticker').value = tab.providerConfig.ticker || '';
  $('root').value = tab.providerConfig.root || '';
  $('expiry').value = tab.providerConfig.expiry || defaultExpiry();
  $('yahooSymbol').value = tab.providerConfig.yahooSymbol || '';
  $('pollSec').value = String(tab.providerConfig.pollSec ?? 5);
  $('tailSteps').value = String(tab.providerConfig.tailSteps ?? 3);
  $('keepPoints').value = String(tab.providerConfig.keepPoints ?? 200);
}

function readFormToTab(tab) {
  tab.providerKey = $('providerKey').value;
  tab.providerConfig = {
    apiBase: $('apiBase').value.trim(),
    ticker: $('ticker').value.trim(),
    root: $('root').value.trim(),
    expiry: $('expiry').value.trim(),
    yahooSymbol: $('yahooSymbol').value.trim(),
    pollSec: Number($('pollSec').value) || 5,
    tailSteps: Number($('tailSteps').value) || 3,
    keepPoints: Number($('keepPoints').value) || 200
  };
}

function renderTabs() {
  const tabsRoot = $('tabs');
  tabsRoot.innerHTML = '';

  for (const tab of state.tabs) {
    const item = document.createElement('div');
    item.className = `tab ${tab.id === state.activeTabId ? 'active' : ''}`;

    const btn = document.createElement('button');
    btn.className = 'tab-title';
    btn.textContent = tab.title;
    btn.onclick = () => {
      state.activeTabId = tab.id;
      applyTabToForm(tab);
      renderTabs();
      renderWidgets();
      persist();
    };
    item.addEventListener('contextmenu', (evt) => {
      evt.preventDefault();
      showTabContextMenu(tab.id, evt.clientX, evt.clientY);
    });

    item.appendChild(btn);
    tabsRoot.appendChild(item);
  }
}

function hideTabContextMenu() {
  const menu = $('tabContextMenu');
  menu.hidden = true;
  tabContextTargetId = null;
}

function showTabContextMenu(tabId, x, y) {
  const menu = $('tabContextMenu');
  tabContextTargetId = tabId;
  menu.hidden = false;
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  $('tabDeleteAction').disabled = state.tabs.length <= 1;
}

function deleteTabById(tabId) {
  if (!tabId || state.tabs.length <= 1) return;

  const idx = state.tabs.findIndex((x) => x.id === tabId);
  if (idx === -1) return;

  state.tabs.splice(idx, 1);
  delete state.historyByTab[tabId];

  if (state.activeTabId === tabId) {
    const next = state.tabs[idx] || state.tabs[idx - 1] || state.tabs[0];
    state.activeTabId = next?.id || null;
  }

  if (state.activeTabId) applyTabToForm(activeTab());
  renderTabs();
  renderWidgets();
  persist();
}

function renameTabById(tabId) {
  const tab = state.tabs.find((x) => x.id === tabId);
  if (!tab) return;

  const nextTitle = window.prompt('Rename tab', tab.title);
  if (nextTitle == null) return;

  const trimmed = nextTitle.trim();
  if (!trimmed) return;
  tab.title = trimmed;
  renderTabs();
  persist();
}

function destroyCharts() {
  for (const { chart } of chartInstances.values()) chart.destroy();
  chartInstances.clear();
}

function renderWidgets() {
  destroyCharts();
  const tab = activeTab();
  const root = $('widgetsRoot');

  if (!tab) {
    root.innerHTML = '<p>No active tab.</p>';
    return;
  }

  const grid = document.createElement('div');
  grid.className = 'widget-grid';

  for (const widget of tab.widgets) {
    const definition = getWidgetDefinition(widget.type);
    if (!definition) continue;

    if (definition.defaultConfig) {
      widget.config ||= {};
      Object.entries(definition.defaultConfig).forEach(([k, v]) => {
        if (widget.config[k] == null) widget.config[k] = v;
      });
    }

    grid.appendChild(createWidgetCard(widget, definition));
  }

  root.replaceChildren(grid);

  for (const widget of tab.widgets) {
    const definition = getWidgetDefinition(widget.type);
    if (!definition) continue;

    const ctx = document.getElementById(`canvas-${widget.id}`)?.getContext('2d');
    if (!ctx) continue;

    const chart = createWidgetChart(ctx, definition);
    chartInstances.set(widget.id, {
      chart,
      mode: definition.mode || 'timeseries',
      metric: definition.metric,
      definition,
      widget
    });
  }

  root.querySelectorAll('[data-widget-id]').forEach((btn) => {
    btn.addEventListener('click', (evt) => {
      const wid = evt.target.getAttribute('data-widget-id');
      tab.widgets = tab.widgets.filter((w) => w.id !== wid);
      renderWidgets();
      persist();
    });
  });

  root.querySelectorAll('[data-widget-strike-id]').forEach((input) => {
    input.addEventListener('change', (evt) => {
      const wid = evt.target.getAttribute('data-widget-strike-id');
      const target = tab.widgets.find((w) => w.id === wid);
      if (!target) return;
      target.config ||= {};
      target.config.baseStrike = Number(evt.target.value) || target.config.baseStrike;
      refreshCharts();
      persist();
    });
  });

  root.querySelectorAll('[data-widget-expiry-start-id]').forEach((input) => {
    input.addEventListener('change', (evt) => {
      const wid = evt.target.getAttribute('data-widget-expiry-start-id');
      const target = tab.widgets.find((w) => w.id === wid);
      if (!target) return;
      target.config ||= {};
      target.config.expiryStart = String(evt.target.value || '').trim();
      persist();
    });
  });

  root.querySelectorAll('[data-widget-expiry-end-id]').forEach((input) => {
    input.addEventListener('change', (evt) => {
      const wid = evt.target.getAttribute('data-widget-expiry-end-id');
      const target = tab.widgets.find((w) => w.id === wid);
      if (!target) return;
      target.config ||= {};
      target.config.expiryEnd = String(evt.target.value || '').trim();
      persist();
    });
  });

  root.querySelectorAll('[data-widget-ticker-id]').forEach((input) => {
    input.addEventListener('change', (evt) => {
      const wid = evt.target.getAttribute('data-widget-ticker-id');
      const target = tab.widgets.find((w) => w.id === wid);
      if (!target) return;
      target.config ||= {};
      target.config.ticker = String(evt.target.value || '').trim();
      persist();
    });
  });

  refreshCharts();
}

function refreshCharts() {
  const tab = activeTab();
  if (!tab) return;

  const history = state.historyByTab[tab.id] || [];
  const latest = history[history.length - 1] || null;

  for (const entry of chartInstances.values()) {
    const { chart, mode, metric, definition, widget } = entry;

    if (mode === 'snapshot-series' && typeof definition.buildSnapshotSeries === 'function') {
      const widgetSnapshot = latest?.widgetSnapshots?.[widget.id] || latest;
      const series = definition.buildSnapshotSeries(widgetSnapshot, widget);
      chart.data.labels = series?.labels || [];

      if (Array.isArray(series?.datasets) && series.datasets.length) {
        chart.data.datasets = series.datasets.map((dataset, idx) => ({
          label: dataset?.label || `Series ${idx + 1}`,
          data: Array.isArray(dataset?.data) ? dataset.data : [],
          borderWidth: 1,
          tension: 0.2,
          pointRadius: 0,
          borderColor: dataset?.borderColor || definition.color || '#7aa2ff'
        }));
      } else {
        chart.data.datasets = [{
          label: definition.defaultTitle,
          data: series?.values || [],
          borderWidth: 1,
          tension: 0.2,
          pointRadius: 0,
          borderColor: definition.color || '#7aa2ff'
        }];
      }

      chart.options.plugins.legend.display = chart.data.datasets.length > 1;
      chart.update();
      continue;
    }

    chart.data.labels = history.map((x) => new Date(x.time).toLocaleTimeString());
    chart.data.datasets[0].data = history.map((x) => x[metric]);
    chart.options.plugins.legend.display = false;
    chart.update();
  }
}

function addWidget(type) {
  const tab = activeTab();
  if (!tab) return;
  const definition = getWidgetDefinition(type);
  if (!definition) return;

  const widgetId = `w-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
  tab.widgets.push({
    id: widgetId,
    type,
    title: definition.defaultTitle,
    config: { ...(definition.defaultConfig || {}) }
  });
  renderWidgets();
  persist();
}

function addTab() {
  const id = `tab-${Date.now()}`;
  const tab = {
    id,
    title: `Tab ${state.tabs.length + 1}`,
    providerKey: 'tradingview',
    providerConfig: {
      apiBase: 'https://scanner.tradingview.com',
      ticker: 'AMEX:SPY',
      root: 'SPY',
      expiry: defaultExpiry(),
      yahooSymbol: 'SPY',
      tailSteps: 3,
      pollSec: 5,
      keepPoints: 200
    },
    widgets: []
  };

  state.tabs.push(tab);
  state.activeTabId = id;
  applyTabToForm(tab);
  renderTabs();
  renderWidgets();
  persist();
}

async function tick() {
  const tab = activeTab();
  if (!tab) return;

  readFormToTab(tab);
  const provider = providers[tab.providerKey];
  if (!provider) {
    setStatus(`Unknown provider: ${tab.providerKey}`);
    return;
  }

  try {
    setStatus('Loading snapshot...');
    const point = await provider.fetchSnapshot(tab.providerConfig, skewMetrics);
    point.widgetSnapshots = {};

    for (const widget of tab.widgets || []) {
      const definition = getWidgetDefinition(widget.type);
      if (!definition || definition.mode !== 'snapshot-series') continue;

      const widgetExpiryStart = String(widget?.config?.expiryStart || widget?.config?.expiry || '').trim();
      const widgetExpiryEnd = String(widget?.config?.expiryEnd || '').trim();
      const { ticker: widgetTicker, root: widgetRoot } = parseWidgetTicker(widget?.config?.ticker);
      const expiries = expandExpiryRange(widgetExpiryStart, widgetExpiryEnd);
      const primaryExpiry = expiries[0] || widgetExpiryStart;

      const requestConfig = {
        ...tab.providerConfig,
        ...(primaryExpiry ? { expiry: primaryExpiry } : {}),
        ...(widgetTicker && widgetRoot ? { ticker: widgetTicker, root: widgetRoot } : {})
      };

      const hasOverride =
        String(requestConfig.expiry || '') !== String(tab.providerConfig.expiry || '') ||
        String(requestConfig.ticker || '') !== String(tab.providerConfig.ticker || '') ||
        String(requestConfig.root || '') !== String(tab.providerConfig.root || '');

      try {
        if (!hasOverride && expiries.length <= 1) continue;

        if (expiries.length <= 1) {
          const widgetPoint = await provider.fetchSnapshot(requestConfig, skewMetrics);
          point.widgetSnapshots[widget.id] = widgetPoint;
          continue;
        }

        const byExpiry = {};
        for (const expiry of expiries) {
          const widgetPoint = await provider.fetchSnapshot({ ...requestConfig, expiry }, skewMetrics);
          byExpiry[expiry] = widgetPoint;
        }
        point.widgetSnapshots[widget.id] = { byExpiry };
      } catch (_err) {
        // keep fallback to tab-level snapshot
      }
    }

    state.historyByTab[tab.id] ||= [];
    state.historyByTab[tab.id].push(point);

    const keep = Math.max(20, Number(tab.providerConfig.keepPoints) || 200);
    while (state.historyByTab[tab.id].length > keep) {
      state.historyByTab[tab.id].shift();
    }

    refreshCharts();
    setStatus(`ok • px=${point.px?.toFixed(3) ?? 'n/a'} • lower=${point.lower ?? 'n/a'} upper=${point.upper ?? 'n/a'}`);
    persist();
  } catch (err) {
    setStatus(`error: ${err?.message || err}`);
  }
}

function start() {
  stop();
  const tab = activeTab();
  if (!tab) return;

  readFormToTab(tab);
  const poll = Math.max(1, Number(tab.providerConfig.pollSec) || 5);
  $('startBtn').disabled = true;
  $('stopBtn').disabled = false;
  tick();
  timer = setInterval(tick, poll * 1000);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  $('startBtn').disabled = false;
  $('stopBtn').disabled = true;
  setStatus('stopped');
}

function bindEvents() {
  $('startBtn').addEventListener('click', start);
  $('stopBtn').addEventListener('click', stop);
  $('addTabBtn').addEventListener('click', addTab);
  $('addWidgetBtn').addEventListener('click', () => addWidget($('widgetTypeSelect').value));
  $('toggleConfigBtn').addEventListener('click', () => {
    const body = $('configBody');
    const collapsed = body.classList.toggle('is-collapsed');
    $('toggleConfigBtn').textContent = collapsed ? 'Show config' : 'Hide config';
    $('toggleConfigBtn').setAttribute('aria-expanded', String(!collapsed));
  });
  $('tabRenameAction').addEventListener('click', () => {
    renameTabById(tabContextTargetId);
    hideTabContextMenu();
  });
  $('tabDeleteAction').addEventListener('click', () => {
    deleteTabById(tabContextTargetId);
    hideTabContextMenu();
  });
  document.addEventListener('click', () => hideTabContextMenu());
  document.addEventListener('contextmenu', (evt) => {
    if (!evt.target.closest('.tab')) hideTabContextMenu();
  });

  ['providerKey', 'apiBase', 'ticker', 'root', 'expiry', 'yahooSymbol', 'pollSec', 'tailSteps', 'keepPoints'].forEach((id) => {
    $(id).addEventListener('change', () => {
      const tab = activeTab();
      if (!tab) return;
      readFormToTab(tab);
      persist();
    });
  });
}

async function init() {
  bindEvents();
  const loaded = await window.appBridge.loadState();
  state.tabs = loaded.tabs || [];
  state.activeTabId = loaded.activeTabId || state.tabs[0]?.id;

  if (!state.tabs.length) addTab();

  for (const tab of state.tabs) {
    state.historyByTab[tab.id] = [];
    if (!tab.providerConfig.expiry) tab.providerConfig.expiry = defaultExpiry();
    for (const widget of tab.widgets || []) {
      widget.config ||= {};
      if (!widget.config.expiryStart && widget.config.expiry) {
        widget.config.expiryStart = widget.config.expiry;
      }
    }
  }

  if (!state.activeTabId) state.activeTabId = state.tabs[0].id;

  applyTabToForm(activeTab());
  renderTabs();
  renderWidgets();
  setStatus('ready');
}

init();
