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
    const btn = document.createElement('button');
    btn.className = `tab ${tab.id === state.activeTabId ? 'active' : ''}`;
    btn.textContent = tab.title;
    btn.onclick = () => {
      state.activeTabId = tab.id;
      applyTabToForm(tab);
      renderTabs();
      renderWidgets();
      persist();
    };
    tabsRoot.appendChild(btn);
  }
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
      const series = definition.buildSnapshotSeries(latest, widget);
      chart.data.labels = series?.labels || [];
      chart.data.datasets[0].data = series?.values || [];
      chart.update();
      continue;
    }

    chart.data.labels = history.map((x) => new Date(x.time).toLocaleTimeString());
    chart.data.datasets[0].data = history.map((x) => x[metric]);
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
  $('addAtmWidgetBtn').addEventListener('click', () => addWidget('atm-skew-line'));
  $('addTailWidgetBtn').addEventListener('click', () => addWidget('tail-skew-line'));
  $('addNDateWidgetBtn').addEventListener('click', () => addWidget('ndate-put-skew-line'));

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
  }

  if (!state.activeTabId) state.activeTabId = state.tabs[0].id;

  applyTabToForm(activeTab());
  renderTabs();
  renderWidgets();
  setStatus('ready');
}

init();
