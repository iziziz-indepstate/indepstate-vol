import { TradingViewProvider } from '../shared/tradingview-provider.js';
import { TheBlockProvider } from '../shared/theblock-provider.js';
import { getWidgetDefinition, widgetDefinitions } from './widgets/index.js';
import { createWidgetCard, createWidgetChartForDefinition } from './widgets/widget-renderers.js';
import { skewMetrics } from './widgets/metrics.js';
import { createWidgetEventBus } from './widget-event-bus.js';
import { createWidgetDataPublishBus } from './widget-data-publish-bus.js';
import { activateAppPlugins, appPluginManifests } from '../plugins/index.js';
import {
  applicableWidgetExtensions,
  normalizeWidgetPluginConfig,
  writeWidgetExtensionControlValue
} from './widget-extensions.js';
import {
  normalizeWidgetParamValue,
  shouldRefreshOnWidgetParamChange,
  WIDGET_PARAM_DATASET
} from './widgets/widget-params.js';
import {
  createChartRuntimeData,
  createDashboardRuntimeSnapshot,
  createMcpRuntimeStore
} from '../shared/mcp-runtime-store.mjs';
import { trimSnapshotForWidgets } from '../shared/snapshot-trim.mjs';

const providers = {
  tradingview: {
    fetchSnapshot: (config, metrics) => (
      typeof window.appBridge?.getTradingViewSnapshot === 'function'
        ? window.appBridge.getTradingViewSnapshot(config)
        : new TradingViewProvider().fetchSnapshot(config, metrics)
    )
  },
  theblock: {
    fetchSnapshot: (config) => (
      typeof window.appBridge?.getTheBlockSnapshot === 'function'
        ? window.appBridge.getTheBlockSnapshot(config)
        : new TheBlockProvider().fetchSnapshot(config)
    )
  }
};

const state = {
  activeTabId: null,
  tabs: [],
  historyByTab: {}
};

const tabTimers = new Map();
const tabTickInFlight = new Set();
const tabRefreshInFlight = new Set();
const tabStatus = {};
const chartInstances = new Map();
const widgetDataStore = new Map();
const mcpRuntimeStore = createMcpRuntimeStore();
const widgetEventBus = createWidgetEventBus();
const widgetDataPublishBus = createWidgetDataPublishBus();
const lifecycleUiByTab = {};
let tabContextTargetId = null;
let renameTargetTabId = null;
let draggedTabId = null;
let historySidecarWidgetId = null;
let persistUiTimer = null;
let persistTimer = null;
let persistInFlight = false;
let persistQueued = false;
let lastPersistStartedAt = 0;

const $ = (id) => document.getElementById(id);
const HISTORY_SNAPSHOT_PALETTE = ['#7dffb3', '#7aa2ff', '#f97316', '#eab308', '#d946ef', '#06b6d4', '#ef4444', '#f472b6'];
const PROFILE_MAX_EVENTS = 1200;
const profileEvents = [];
let profilerEnabled = false;

function pushProfileEvent(event) {
  if (!profilerEnabled) return;
  profileEvents.push({
    ts: new Date().toISOString(),
    process: 'renderer',
    ...event
  });
  while (profileEvents.length > PROFILE_MAX_EVENTS) profileEvents.shift();
}

function profileDuration(name, start, detail = {}) {
  if (!profilerEnabled) return 0;
  const durationMs = performance.now() - start;
  const event = {
    name,
    detail,
    durationMs: Number(durationMs.toFixed(2))
  };
  pushProfileEvent(event);
  if (durationMs >= 80) console.info('[IS-VOL profiler]', event);
  return durationMs;
}

async function profileMeasure(name, detail, fn) {
  if (!profilerEnabled) return fn();
  const start = performance.now();
  try {
    return await fn();
  } finally {
    profileDuration(name, start, detail);
  }
}

function summarizeProfileEvents() {
  const groups = new Map();
  for (const event of profileEvents) {
    const curr = groups.get(event.name) || { name: event.name, count: 0, total: 0, max: 0 };
    curr.count += 1;
    curr.total += event.durationMs || 0;
    curr.max = Math.max(curr.max, event.durationMs || 0);
    groups.set(event.name, curr);
  }
  return Array.from(groups.values())
    .map((row) => ({
      name: row.name,
      count: row.count,
      avgMs: Number((row.total / row.count).toFixed(2)),
      maxMs: Number(row.max.toFixed(2))
    }))
    .sort((a, b) => b.maxMs - a.maxMs);
}

window.isVolProfiler = {
  enabled: () => profilerEnabled,
  clear: () => {
    profileEvents.length = 0;
    return { ok: true };
  },
  events: () => [...profileEvents],
  summary: () => summarizeProfileEvents(),
  export: async () => {
    if (!profilerEnabled) {
      const result = { ok: false, error: 'Profiler is disabled. Restart with --profile or IS_VOL_PROFILER=1.' };
      console.info('[IS-VOL profiler]', result.error);
      return result;
    }
    const result = await window.appBridge.exportProfilerEvents?.([...profileEvents]);
    console.info('[IS-VOL profiler] exported', result);
    return result;
  }
};

async function exportProfilerToStatus() {
  try {
    if (!profilerEnabled) {
      setStatus('profiler disabled • restart with --profile or IS_VOL_PROFILER=1');
      return { ok: false };
    }
    const result = await window.isVolProfiler.export();
    setStatus(`profiler exported: ${result?.file || 'ok'}`);
    return result;
  } catch (err) {
    const message = err?.message || String(err);
    setStatus(`profiler export failed: ${message}`);
    console.warn('Failed to export profiler events', err);
    return null;
  }
}

function historySnapshotColor(idx) {
  return HISTORY_SNAPSHOT_PALETTE[idx % HISTORY_SNAPSHOT_PALETTE.length];
}

function activeTab() {
  return state.tabs.find((t) => t.id === state.activeTabId);
}

function isActiveTabId(tabId) {
  return Boolean(tabId) && state.activeTabId === tabId;
}

function defaultExpiry() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}


function populateWidgetTypeSelect() {
  const select = $('widgetTypeSelect');
  if (!select) return;

  const prev = select.value;
  select.innerHTML = '';

  for (const definition of widgetDefinitions) {
    const option = document.createElement('option');
    option.value = definition.type;
    option.textContent = definition.defaultTitle || definition.type;
    select.appendChild(option);
  }

  if (prev && widgetDefinitions.some((definition) => definition.type === prev)) {
    select.value = prev;
  }
}

function setStatus(text) {
  $('globalStatus').textContent = text;
}

function setTabStatus(tabId, text) {
  if (!tabId) return;
  tabStatus[tabId] = text;
  if (state.activeTabId === tabId) setStatus(text);
}

function formatStatusUpdateTime(value) {
  const dt = value ? new Date(value) : new Date();
  if (Number.isNaN(dt.getTime())) return 'n/a';
  return dt.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

function setPollState(isRunning) {
  const dot = $('pollStateDot');
  dot.classList.toggle('is-running', isRunning);
  dot.classList.toggle('is-stopped', !isRunning);
}

function updatePollingControlsForActiveTab() {
  const tab = activeTab();
  const running = tab ? tabTimers.has(tab.id) : false;
  const refreshing = tab ? tabRefreshInFlight.has(tab.id) : false;
  const startBtn = $('startBtn');
  startBtn.disabled = running || refreshing;
  startBtn.classList.toggle('is-active', running);
  startBtn.setAttribute('aria-pressed', String(running));
  $('stopBtn').disabled = !running || refreshing;
  $('refreshBtn').disabled = refreshing;
  $('clearSnapshotBtn').disabled = refreshing;
  setPollState(running || refreshing);
}

function updateLifecycleUiFromResponse(response) {
  const next = response?.lifecycleUiByTab || response;
  if (!next || typeof next !== 'object') return;
  Object.keys(lifecycleUiByTab).forEach((key) => delete lifecycleUiByTab[key]);
  Object.assign(lifecycleUiByTab, next);
}

function runningTabIds() {
  return Array.from(tabTimers.keys());
}

async function syncDataSourcesToMain() {
  if (typeof window.appBridge?.syncDataSources !== 'function') return;
  const response = await window.appBridge.syncDataSources({
    tabs: state.tabs,
    runningTabIds: runningTabIds()
  });
  updateLifecycleUiFromResponse(response);
  renderDataSourceLifecycleControls(activeTab());
}

function lifecycleSettingsFor(tab, lifecycleId) {
  tab.providerConfig ||= {};
  tab.providerConfig.lifecycleSettings ||= {};
  tab.providerConfig.lifecycleSettings[lifecycleId] ||= {};
  return tab.providerConfig.lifecycleSettings[lifecycleId];
}

function normalizeLifecycleControlValue(control, value) {
  if (control?.type === 'checkbox') return Boolean(value);
  if (control?.type === 'time') {
    const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/);
    if (!match) return '';
    return `${match[1].padStart(2, '0')}:${match[2]}`;
  }
  if (control?.type === 'time-list') {
    const source = Array.isArray(value) ? value : String(value || '').split(/[,\s]+/);
    return Array.from(new Set(
      source
        .map((item) => normalizeLifecycleControlValue({ type: 'time' }, item))
        .filter(Boolean)
    )).sort();
  }
  if (control?.type === 'number') {
    const number = Number(value);
    return Number.isFinite(number) ? number : '';
  }
  return value == null ? '' : String(value);
}

function valueForLifecycleControl(tab, lifecycle, control) {
  const settings = lifecycleSettingsFor(tab, lifecycle.id);
  if (settings[control.name] !== undefined) return normalizeLifecycleControlValue(control, settings[control.name]);
  if (lifecycle.values?.[control.name] !== undefined) return normalizeLifecycleControlValue(control, lifecycle.values[control.name]);
  return normalizeLifecycleControlValue(control, control.defaultValue);
}

function createLifecycleTimeListRow(lifecycleId, controlName, labelText, time, index) {
  const row = document.createElement('div');
  row.className = 'lifecycle-time-row';
  const input = document.createElement('input');
  input.type = 'text';
  input.inputMode = 'numeric';
  input.placeholder = 'HH:mm';
  input.pattern = '^\\d{1,2}:\\d{2}$';
  input.value = time || '';
  input.dataset.lifecycleId = lifecycleId;
  input.dataset.lifecycleControl = controlName;
  input.dataset.lifecycleTimeListIndex = String(index);
  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'btn btn-compact btn-icon-only';
  removeBtn.title = `Remove ${time || labelText}`;
  removeBtn.setAttribute('aria-label', `Remove ${time || labelText}`);
  removeBtn.dataset.lifecycleId = lifecycleId;
  removeBtn.dataset.lifecycleTimeListRemove = controlName;
  removeBtn.dataset.lifecycleTimeListIndex = String(index);
  removeBtn.textContent = 'x';
  row.appendChild(input);
  row.appendChild(removeBtn);
  return row;
}

function renderDataSourceLifecycleControls(tab) {
  const root = $('dataSourceLifecycleControls');
  if (!root) return;
  const lifecycles = tab?.id ? (lifecycleUiByTab[tab.id] || []) : [];
  root.hidden = !lifecycles.length;
  root.innerHTML = '';
  if (!lifecycles.length || !tab) return;

  for (const lifecycle of lifecycles) {
    const section = document.createElement('section');
    section.className = 'lifecycle-section';

    const title = document.createElement('h3');
    title.className = 'lifecycle-title';
    title.textContent = lifecycle.title || lifecycle.id;
    section.appendChild(title);

    const grid = document.createElement('div');
    grid.className = 'lifecycle-grid';
    for (const control of Array.isArray(lifecycle.controls) ? lifecycle.controls : []) {
      const value = valueForLifecycleControl(tab, lifecycle, control);
      const label = document.createElement('label');
      if (control.type === 'time-list') {
        label.className = 'lifecycle-time-list-field';
        const header = document.createElement('div');
        header.className = 'lifecycle-time-list-header';
        const text = document.createElement('span');
        text.textContent = control.label || control.name;
        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'btn btn-compact btn-icon-only';
        addBtn.title = `Add ${control.label || control.name}`;
        addBtn.setAttribute('aria-label', `Add ${control.label || control.name}`);
        addBtn.dataset.lifecycleId = lifecycle.id;
        addBtn.dataset.lifecycleTimeListAdd = control.name;
        addBtn.textContent = '+';
        header.appendChild(text);
        header.appendChild(addBtn);
        label.appendChild(header);

        const list = document.createElement('div');
        list.className = 'lifecycle-time-list';
        const times = Array.isArray(value) && value.length ? value : [''];
        times.forEach((time, index) => {
          list.appendChild(createLifecycleTimeListRow(
            lifecycle.id,
            control.name,
            control.label || control.name,
            time,
            index
          ));
        });
        label.appendChild(list);
        grid.appendChild(label);
        continue;
      }
      const input = document.createElement('input');
      input.dataset.lifecycleId = lifecycle.id;
      input.dataset.lifecycleControl = control.name;
      input.type = control.type === 'checkbox' ? 'checkbox' : (control.type === 'time' ? 'text' : control.type);
      if (control.type === 'time') {
        input.inputMode = 'numeric';
        input.placeholder = 'HH:mm';
        input.pattern = '^\\d{1,2}:\\d{2}$';
      }
      if (control.min != null) input.min = String(control.min);
      if (control.max != null) input.max = String(control.max);
      if (control.type === 'checkbox') {
        label.className = 'checkbox-field';
        input.checked = Boolean(value);
        label.appendChild(input);
        const text = document.createElement('span');
        text.textContent = control.label || control.name;
        label.appendChild(text);
      } else {
        label.textContent = control.label || control.name;
        input.value = value == null ? '' : String(value);
        label.appendChild(input);
      }
      grid.appendChild(label);
    }
    section.appendChild(grid);
    root.appendChild(section);
  }
}

function lifecycleControlFor(tab, lifecycleId, controlName, fallbackType = 'text') {
  const lifecycle = (lifecycleUiByTab[tab?.id] || []).find((item) => item.id === lifecycleId);
  return (lifecycle?.controls || []).find((item) => item.name === controlName) || { name: controlName, type: fallbackType };
}

function writeLifecycleSettings(tab, lifecycleId, controlName, value) {
  const control = lifecycleControlFor(tab, lifecycleId, controlName);
  const settings = lifecycleSettingsFor(tab, lifecycleId);
  settings[controlName] = normalizeLifecycleControlValue(control, value);
  persistUiState();
  if (typeof window.appBridge?.updateDataSourceLifecycleSettings !== 'function') return;
  window.appBridge.updateDataSourceLifecycleSettings({
    tabId: tab.id,
    lifecycleId,
    values: { ...settings },
    tabs: state.tabs,
    runningTabIds: runningTabIds()
  }).then((response) => {
    updateLifecycleUiFromResponse(response);
    renderDataSourceLifecycleControls(activeTab());
  }).catch((err) => console.warn('Failed to update datasource lifecycle settings', err));
}

function readTimeListInputs(tab, lifecycleId, controlName) {
  return Array.from(document.querySelectorAll(
    `input[data-lifecycle-id="${lifecycleId}"][data-lifecycle-control="${controlName}"][data-lifecycle-time-list-index]`
  )).map((input) => input.value);
}

function persist() {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (persistInFlight) {
    persistQueued = true;
    return;
  }

  persistInFlight = true;
  persistQueued = false;
  lastPersistStartedAt = Date.now();
  const start = performance.now();
  window.appBridge.saveState({
    activeTabId: state.activeTabId,
    tabs: state.tabs,
    historyByTab: state.historyByTab
  }).catch((err) => {
    console.warn('Failed to persist dashboard state', err);
  }).finally(() => {
    profileDuration('persist:saveState', start, {
      tabs: state.tabs.length,
      historyPoints: Object.values(state.historyByTab || {}).reduce((acc, rows) => acc + (Array.isArray(rows) ? rows.length : 0), 0)
    });
    persistInFlight = false;
    if (persistQueued) schedulePersist(500);
  });
}

function schedulePersist(delayMs = 1500) {
  const elapsed = Date.now() - lastPersistStartedAt;
  const effectiveDelay = elapsed > 30000 ? 0 : delayMs;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persist();
  }, effectiveDelay);
}

function saveRawSnapshotDeferred(payload) {
  if (typeof window.appBridge.saveRawSnapshot !== 'function') return;
  setTimeout(() => {
    const start = performance.now();
    window.appBridge.saveRawSnapshot(payload)
      .then(() => profileDuration('rawSnapshot:save', start, {
        tabId: payload?.tab?.id,
        providerKey: payload?.tab?.providerKey
      }))
      .catch((err) => console.warn('Failed to save raw snapshot', err));
  }, 750);
}

function persistHistoryPoint(tabId, point, keep) {
  if (typeof window.appBridge.appendHistoryPoint !== 'function') {
    schedulePersist();
    return;
  }
  const start = performance.now();
  window.appBridge.appendHistoryPoint({ tabId, point, keep })
    .then(() => profileDuration('persist:appendHistoryPoint', start, { tabId, keep }))
    .catch((err) => {
      console.warn('Failed to persist history point', err);
      schedulePersist();
    });
}

function persistUiState() {
  if (typeof window.appBridge.saveUiState === 'function') {
    window.appBridge.saveUiState({
      activeTabId: state.activeTabId,
      tabs: state.tabs
    });
    return;
  }
  persist();
}

function schedulePersistUiState(delayMs = 250) {
  if (persistUiTimer) clearTimeout(persistUiTimer);
  persistUiTimer = setTimeout(() => {
    persistUiTimer = null;
    persistUiState();
  }, delayMs);
}

function tabSupportsHistorySnapshots(tab) {
  if (!tab || !Array.isArray(tab.widgets)) return false;
  return tab.widgets.some((widget) => {
    const type = String(widget?.type || '');
    const definition = getWidgetDefinition(type);
    return type.startsWith('ndate-skew-') || Boolean(definition?.requiresHistory);
  });
}

function ensureTabHistoryPolicy(tab) {
  if (!tab?.id) return;
  if (!tabSupportsHistorySnapshots(tab)) {
    state.historyByTab[tab.id] = [];
    return;
  }
  if (!Array.isArray(state.historyByTab[tab.id])) state.historyByTab[tab.id] = [];
}

function normalizeProviderConfig(providerConfig = {}) {
  if (providerConfig.saveRawSnapshots == null) providerConfig.saveRawSnapshots = true;
  if (providerConfig.compactHistorySnapshots == null) providerConfig.compactHistorySnapshots = true;
  return providerConfig;
}

function shouldSaveRawSnapshots(tab) {
  return tab?.providerConfig?.saveRawSnapshots !== false;
}

function shouldCompactHistorySnapshots(tab) {
  return tab?.providerConfig?.compactHistorySnapshots !== false;
}

function updateProviderConfigVisibility(providerKey) {
  document.querySelectorAll('[data-provider-setting]').forEach((node) => {
    const allowed = String(node.dataset.providerSetting || '')
      .split(/\s+/)
      .filter(Boolean);
    node.hidden = !allowed.includes(providerKey);
  });
}

function trimHistoryForTab(tab) {
  if (!tab?.id || !Array.isArray(state.historyByTab[tab.id])) return;
  if (!shouldCompactHistorySnapshots(tab)) return;
  state.historyByTab[tab.id] = state.historyByTab[tab.id].map((snapshot) => trimSnapshotForWidgets(snapshot, tab));
}

function applyTabToForm(tab) {
  tab.providerConfig = normalizeProviderConfig(tab.providerConfig || {});
  $('providerKey').value = tab.providerKey;
  updateProviderConfigVisibility(tab.providerKey);
  $('apiBase').value = tab.providerConfig.apiBase || '';
  $('ticker').value = tab.providerConfig.ticker || '';
  $('root').value = tab.providerConfig.root || '';
  $('expiryStart').value = tab.providerConfig.expiryStart || tab.providerConfig.expiry || defaultExpiry();
  $('expiryEnd').value = tab.providerConfig.expiryEnd || '';
  $('yahooSymbol').value = tab.providerConfig.yahooSymbol || '';
  $('pollSec').value = String(tab.providerConfig.pollSec ?? 5);
  $('keepPoints').value = String(tab.providerConfig.keepPoints ?? 200);
  $('saveRawSnapshots').checked = shouldSaveRawSnapshots(tab);
  $('compactHistorySnapshots').checked = shouldCompactHistorySnapshots(tab);
  renderDataSourceLifecycleControls(tab);
}

function readFormToTab(tab) {
  const providerKey = $('providerKey').value;
  tab.providerKey = providerKey;
  const nextConfig = {
    ...(tab.providerConfig || {}),
    saveRawSnapshots: $('saveRawSnapshots').checked,
    compactHistorySnapshots: $('compactHistorySnapshots').checked
  };
  if (providerKey === 'tradingview') {
    Object.assign(nextConfig, {
      apiBase: $('apiBase').value.trim(),
      ticker: $('ticker').value.trim(),
      root: $('root').value.trim(),
      expiryStart: $('expiryStart').value.trim(),
      expiryEnd: $('expiryEnd').value.trim(),
      yahooSymbol: $('yahooSymbol').value.trim(),
      pollSec: Number($('pollSec').value) || 5,
      keepPoints: Number($('keepPoints').value) || 200
    });
  }
  tab.providerConfig = normalizeProviderConfig(nextConfig);
  updateProviderConfigVisibility(providerKey);
}

function renderTabs() {
  const tabsRoot = $('tabs');
  tabsRoot.innerHTML = '';

  for (const tab of state.tabs) {
    const item = document.createElement('div');
    item.className = `tab ${tab.id === state.activeTabId ? 'active' : ''}`;
    item.draggable = true;
    item.dataset.tabId = tab.id;

    const btn = document.createElement('button');
    btn.className = 'tab-title';
    btn.textContent = tab.title;
    btn.onclick = () => {
      state.activeTabId = tab.id;
      applyTabToForm(tab);
      renderTabs();
      renderWidgets();
      setStatus(tabStatus[tab.id] || 'ready');
      updatePollingControlsForActiveTab();
      renderDataSourceLifecycleControls(tab);
      persistUiState();
    };
    item.addEventListener('contextmenu', (evt) => {
      evt.preventDefault();
      showTabContextMenu(tab.id, evt.clientX, evt.clientY);
    });
    item.addEventListener('dragstart', (evt) => {
      draggedTabId = tab.id;
      item.classList.add('is-dragging');
      if (evt.dataTransfer) {
        evt.dataTransfer.effectAllowed = 'move';
        evt.dataTransfer.setData('text/plain', tab.id);
      }
    });
    item.addEventListener('dragend', () => {
      draggedTabId = null;
      item.classList.remove('is-dragging');
      tabsRoot.querySelectorAll('.tab.is-drag-over').forEach((node) => node.classList.remove('is-drag-over'));
    });
    item.addEventListener('dragover', (evt) => {
      if (!draggedTabId || draggedTabId === tab.id) return;
      evt.preventDefault();
      item.classList.add('is-drag-over');
      if (evt.dataTransfer) evt.dataTransfer.dropEffect = 'move';
    });
    item.addEventListener('dragleave', () => {
      item.classList.remove('is-drag-over');
    });
    item.addEventListener('drop', (evt) => {
      evt.preventDefault();
      item.classList.remove('is-drag-over');
      const fromTabId = draggedTabId || evt.dataTransfer?.getData('text/plain');
      if (!fromTabId || fromTabId === tab.id) return;

      const fromIdx = state.tabs.findIndex((x) => x.id === fromTabId);
      const toIdx = state.tabs.findIndex((x) => x.id === tab.id);
      if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return;

      const [moved] = state.tabs.splice(fromIdx, 1);
      const insertAt = fromIdx < toIdx ? toIdx - 1 : toIdx;
      state.tabs.splice(insertAt, 0, moved);
      renderTabs();
      persistUiState();
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
  delete tabStatus[tabId];
  mcpRuntimeStore.clearTab(tabId);
  stopTabPolling(tabId);

  if (state.activeTabId === tabId) {
    const next = state.tabs[idx] || state.tabs[idx - 1] || state.tabs[0];
    state.activeTabId = next?.id || null;
  }

  if (state.activeTabId) applyTabToForm(activeTab());
  renderTabs();
  renderWidgets();
  setStatus(tabStatus[state.activeTabId] || 'ready');
  updatePollingControlsForActiveTab();
  syncDataSourcesToMain().catch((err) => console.warn('Failed to sync deleted datasource', err));
  persistUiState();
}

function renameTabById(tabId, nextTitleRaw) {
  const tab = state.tabs.find((x) => x.id === tabId);
  if (!tab) return;
  const trimmed = String(nextTitleRaw || '').trim();
  if (!trimmed) return;
  tab.title = trimmed;
  renderTabs();
  persistUiState();
}

function openRenameTabModal(tabId) {
  const tab = state.tabs.find((x) => x.id === tabId);
  if (!tab) return;
  renameTargetTabId = tabId;
  $('renameTabInput').value = tab.title;
  $('renameTabModal').hidden = false;
  $('renameTabInput').focus();
  $('renameTabInput').select();
}

function closeRenameTabModal() {
  $('renameTabModal').hidden = true;
  renameTargetTabId = null;
}

function destroyCharts() {
  for (const { chart, definition, widget, eventPort } of chartInstances.values()) {
    if (chart && typeof chart.destroy === 'function') chart.destroy();
    eventPort?.destroy?.();
    if (typeof definition?.destroy === 'function') {
      const target = document.getElementById(`widget-body-${widget.id}`);
      if (target) definition.destroy(target);
    }
  }
  chartInstances.clear();
}

function widgetDataKey(tabId, widgetId) {
  return `${tabId || ''}:${widgetId || ''}`;
}

function publishWidgetData(tabId, widgetId, data, sourceSnapshotTime = null) {
  if (!tabId || !widgetId) return;
  const tab = state.tabs.find((item) => item.id === tabId) || null;
  const widget = tab?.widgets?.find((item) => item.id === widgetId) || null;
  const definition = widget ? getWidgetDefinition(widget.type) : null;
  const output = {
    ...data,
    tabId,
    widgetId,
    updatedAt: new Date().toISOString()
  };
  widgetDataStore.set(widgetDataKey(tabId, widgetId), output);
  mcpRuntimeStore.set(tabId, widgetId, {
    kind: 'table',
    mode: 'table',
    type: data?.type || null,
    status: data?.status || 'ok',
    title: data?.title || null,
    sourceSnapshotTime,
    output
  });
  widgetDataPublishBus.publish({
    tab,
    widget,
    definition,
    output,
    sourceSnapshotTime
  });
}

function clearWidgetData(tabId, widgetId) {
  if (!tabId || !widgetId) return;
  widgetDataStore.delete(widgetDataKey(tabId, widgetId));
  mcpRuntimeStore.clear(tabId, widgetId);
}

function publishMcpWidgetRuntimeData(tabId, widgetId, data) {
  if (!tabId || !widgetId) return;
  mcpRuntimeStore.set(tabId, widgetId, data);
}

function chartRuntimeDataForWidget(tabId, widgetId) {
  const tab = activeTab();
  if (!tab || tab.id !== tabId || !widgetId) return null;
  const entry = chartInstances.get(widgetId);
  if (!entry?.chart || entry.mode === 'table') return null;
  const history = state.historyByTab[tab.id] || [];
  const latest = history[history.length - 1] || null;
  return createChartRuntimeData({
    widget: entry.widget,
    definition: entry.definition,
    labels: entry.chart?.data?.labels || [],
    datasets: entry.chart?.data?.datasets || [],
    title: entry.chart?.options?.plugins?.title?.text || '',
    historyLength: history.length,
    sourceSnapshotTime: latest?.time || null
  });
}

function runtimeDataForWidget(tabId, widgetId) {
  return mcpRuntimeStore.get(tabId, widgetId) || chartRuntimeDataForWidget(tabId, widgetId);
}

function dashboardRuntimeSnapshot() {
  return createDashboardRuntimeSnapshot({
    state,
    widgetDefinitions,
    getRuntimeData: runtimeDataForWidget
  });
}

function bindMcpRuntimeBridge() {
  if (typeof window.appBridge?.onMcpRuntimeStateRequest !== 'function') return;
  window.appBridge.onMcpRuntimeStateRequest((message) => {
    const requestId = message?.requestId;
    if (!requestId) return;
    try {
      window.appBridge.sendMcpRuntimeStateResponse({
        requestId,
        payload: dashboardRuntimeSnapshot()
      });
    } catch (err) {
      window.appBridge.sendMcpRuntimeStateResponse({
        requestId,
        error: err?.message || String(err)
      });
    }
  });
}

function bindWidgetEventSubscribers() {
  activateAppPlugins(appPluginManifests, {
    eventBus: widgetEventBus,
    widgetDataEvents: widgetDataPublishBus,
    getWidgetDefinition,
    appBridge: window.appBridge,
    clipboard: {
      writeText: (text) => navigator.clipboard.writeText(text)
    },
    setStatus
  });
}

function readWidgetDataByType(tab, type) {
  if (!tab || !type) return [];
  return (tab.widgets || [])
    .filter((widget) => widget.type === type)
    .map((widget) => widgetDataStore.get(widgetDataKey(tab.id, widget.id)))
    .filter(Boolean);
}

function getHiddenSnapshotSeriesLabels(widget) {
  const hidden = widget?.config?.hiddenSnapshotSeriesLabels;
  return Array.isArray(hidden) ? hidden.filter((label) => typeof label === 'string' && label.trim()) : [];
}

function getSelectedHistorySnapshotTimes(widget) {
  const selected = widget?.config?.historySnapshotTimes;
  if (!Array.isArray(selected)) return [];
  return selected
    .map((value) => String(value || '').trim())
    .filter(Boolean);
}

function shouldUseCommonHistoryStrikeRange(widget) {
  return widget?.config?.commonHistoryStrikeRange === true;
}

function shouldHideCurrentSnapshotSeries(widget) {
  return widget?.config?.hideCurrentSnapshotSeries === true;
}

function formatSnapshotOptionLabel(snapshot, idxFromEnd) {
  const dt = new Date(snapshot?.time || 0);
  const isValid = !Number.isNaN(dt.getTime());
  const timeText = isValid ? dt.toLocaleString() : String(snapshot?.time || `Snapshot ${idxFromEnd}`);
  return idxFromEnd > 0 ? `${timeText} (-${idxFromEnd})` : timeText;
}

function historyOptionId(widgetId, time, idx) {
  return `history-${widgetId}-${String(time).replace(/[^a-zA-Z0-9_-]/g, '-')}-${idx}`;
}

function collectHistoricalComparisons(history, widget) {
  const selectedTimes = getSelectedHistorySnapshotTimes(widget);
  const selectedSet = new Set(selectedTimes);
  if (!selectedSet.size || !Array.isArray(history) || history.length < 2) return [];

  const latest = history[history.length - 1];
  const useHistoryColors = selectedTimes.length > 1;
  const colorByTime = new Map(selectedTimes.map((time, idx) => [time, useHistoryColors ? historySnapshotColor(idx) : null]));
  const out = [];
  for (let idx = history.length - 2; idx >= 0; idx -= 1) {
    const snapshot = history[idx];
    const time = String(snapshot?.time || '');
    if (!selectedSet.has(time)) continue;
    const idxFromEnd = Math.max(1, history.length - 1 - idx);
    out.push({
      snapshot,
      time,
      idxFromEnd,
      label: formatSnapshotOptionLabel(snapshot, idxFromEnd),
      historyColor: colorByTime.get(time) || null,
      isLatestDuplicate: snapshot === latest
    });
  }
  return out.filter((item) => !item.isLatestDuplicate);
}

function updateWidgetHistoryControls(root, tab) {
  const history = Array.isArray(state.historyByTab?.[tab?.id]) ? state.historyByTab[tab.id] : [];
  const latest = history[history.length - 1] || null;
  const latestTime = String(latest?.time || '');
  const hasComparableHistory = history.length > 1;

  root.querySelectorAll('[data-widget-history-toggle-widget-id]').forEach((toggle) => {
    toggle.disabled = !hasComparableHistory;
    toggle.classList.toggle('is-empty', !hasComparableHistory);
  });

  const widget = tab.widgets.find((w) => w.id === historySidecarWidgetId);
  const sidecar = root.querySelector('[data-history-sidecar]');
  const sidecarBody = root.querySelector('[data-history-sidecar-body]');
  const sidecarTitle = root.querySelector('[data-history-sidecar-title]');
  const sidecarClose = root.querySelector('[data-history-sidecar-close]');
  const sidecarDelete = root.querySelector('[data-history-sidecar-delete]');

  if (!sidecar || !sidecarBody || !sidecarTitle || !sidecarClose || !sidecarDelete) return;

  if (!hasComparableHistory || !widget || !String(widget?.type || '').startsWith('ndate-skew-')) {
    sidecar.hidden = true;
    sidecarBody.innerHTML = '';
    sidecarTitle.textContent = 'history';
    sidecarDelete.disabled = true;
    return;
  }

  widget.config ||= {};
  const selectedHistoryTimes = getSelectedHistorySnapshotTimes(widget).filter((time) => time !== latestTime);
  const selectedTimes = new Set(selectedHistoryTimes);
  const commonRangeChecked = shouldUseCommonHistoryStrikeRange(widget) ? ' checked' : '';
  const hideCurrentChecked = shouldHideCurrentSnapshotSeries(widget) ? ' checked' : '';
  const selectedColorByTime = new Map();
  if (selectedHistoryTimes.length > 1) {
    selectedHistoryTimes.forEach((time, idx) => selectedColorByTime.set(time, historySnapshotColor(idx)));
  }
  const optionsHtml = [];
  for (let idx = history.length - 2; idx >= 0; idx -= 1) {
    const snapshot = history[idx];
    const time = String(snapshot?.time || '');
    if (!time) continue;
    const idxFromEnd = history.length - 1 - idx;
    const selected = selectedTimes.has(time) ? ' checked' : '';
    const optionId = historyOptionId(widget.id, time, idxFromEnd);
    const historyColor = selectedColorByTime.get(time);
    const colorStyle = historyColor ? ` style="--history-color: ${historyColor}"` : '';
    const swatch = historyColor ? '<span class="widget-history-swatch" aria-hidden="true"></span>' : '';
    optionsHtml.push(`
      <label class="widget-history-option${historyColor ? ' is-colored' : ''}" for="${optionId}"${colorStyle}>
        <input id="${optionId}" type="checkbox" value="${time}"${selected} data-widget-history-option-widget-id="${widget.id}" />
        ${swatch}
        <span>${formatSnapshotOptionLabel(snapshot, idxFromEnd)}</span>
      </label>
    `);
  }

  sidecarTitle.textContent = `history • ${widget.title || widget.type}`;
  sidecarBody.innerHTML = optionsHtml.length
    ? `<label class="widget-history-option widget-history-setting">
        <input type="checkbox"${commonRangeChecked} data-widget-history-common-range-widget-id="${widget.id}" />
        <span>common strike range</span>
      </label>
      <label class="widget-history-option widget-history-setting">
        <input type="checkbox"${hideCurrentChecked} data-widget-history-hide-current-widget-id="${widget.id}" />
        <span>hide current</span>
      </label>${optionsHtml.join('')}`
    : '<div class="widget-history-empty">no history</div>';
  sidecar.hidden = false;
  sidecarClose.disabled = false;
  sidecarDelete.disabled = optionsHtml.length === 0;
}

function syncHiddenSnapshotSeriesLabels(widget, chart) {
  if (!widget || !chart) return;
  widget.config ||= {};
  const hiddenLabels = chart.data.datasets
    .filter((dataset, idx) => !chart.isDatasetVisible(idx))
    .map((dataset, idx) => dataset?.label || `Series ${idx + 1}`);
  widget.config.hiddenSnapshotSeriesLabels = hiddenLabels;
}

function applyHiddenSnapshotSeriesLabels(widget, chart) {
  if (!widget || !chart) return;
  const hiddenLabels = new Set(getHiddenSnapshotSeriesLabels(widget));
  chart.data.datasets.forEach((dataset, idx) => {
    const label = dataset?.label || `Series ${idx + 1}`;
    chart.setDatasetVisibility(idx, !hiddenLabels.has(label));
  });
}

function syncLinkedHistoryVisibility(chart) {
  if (!chart) return;
  chart.data.datasets.forEach((dataset, idx) => {
    if (!Array.isArray(dataset?.linkedHistoryIndices) || !dataset.linkedHistoryIndices.length) return;
    const baseVisible = chart.isDatasetVisible(idx);
    dataset.linkedHistoryIndices.forEach((linkedIdx) => {
      if (!Number.isInteger(linkedIdx)) return;
      if (linkedIdx < 0 || linkedIdx >= chart.data.datasets.length) return;
      chart.setDatasetVisibility(linkedIdx, baseVisible);
    });
  });
}

function sortChartLabels(labels, referenceLabels = []) {
  const uniqueLabels = Array.from(new Set((labels || []).map((label) => String(label))));
  const numeric = uniqueLabels.every((label) => Number.isFinite(Number(label)));
  if (!numeric) return uniqueLabels.sort((a, b) => a.localeCompare(b));

  const reference = (referenceLabels || []).map(Number).filter(Number.isFinite);
  const descending = reference.length >= 2 && reference[0] > reference[reference.length - 1];
  return uniqueLabels.sort((a, b) => descending ? Number(b) - Number(a) : Number(a) - Number(b));
}

function numericRangeForDataset(labels, data) {
  let min = Infinity;
  let max = -Infinity;
  (labels || []).forEach((label, idx) => {
    const x = Number(label);
    const y = Array.isArray(data) ? data[idx] : null;
    if (!Number.isFinite(x) || !Number.isFinite(Number(y))) return;
    min = Math.min(min, x);
    max = Math.max(max, x);
  });
  return min <= max ? { min, max } : null;
}

function commonNumericRange(seriesSpecs) {
  const ranges = (seriesSpecs || [])
    .map((spec) => numericRangeForDataset(spec?.labels, spec?.data))
    .filter(Boolean);
  if (ranges.length < 2) return null;

  const min = Math.max(...ranges.map((range) => range.min));
  const max = Math.min(...ranges.map((range) => range.max));
  return min <= max ? { min, max } : null;
}

function outerNumericRange(seriesSpecs) {
  const ranges = (seriesSpecs || [])
    .map((spec) => numericRangeForDataset(spec?.labels, spec?.data))
    .filter(Boolean);
  if (!ranges.length) return null;

  const min = Math.min(...ranges.map((range) => range.min));
  const max = Math.max(...ranges.map((range) => range.max));
  return min <= max ? { min, max } : null;
}

function finiteLabelSetForDataset(labels, data) {
  const out = new Set();
  (labels || []).forEach((label, idx) => {
    const x = Number(label);
    const y = Array.isArray(data) ? data[idx] : null;
    if (Number.isFinite(x) && Number.isFinite(Number(y))) out.add(String(label));
  });
  return out;
}

function commonFiniteLabels(seriesSpecs) {
  const sets = (seriesSpecs || [])
    .map((spec) => finiteLabelSetForDataset(spec?.labels, spec?.data))
    .filter((set) => set.size > 0);
  if (sets.length < 2) return null;

  let common = new Set(sets[0]);
  for (const set of sets.slice(1)) {
    common = new Set([...common].filter((label) => set.has(label)));
  }
  return common.size ? common : null;
}

function labelInRange(label, range) {
  if (!range) return true;
  const numeric = Number(label);
  return Number.isFinite(numeric) && numeric >= range.min && numeric <= range.max;
}

function labelAllowed(label, range = null, allowedLabels = null) {
  if (allowedLabels && !allowedLabels.has(String(label))) return false;
  return labelInRange(label, range);
}

function datasetPointsForLabels(labels, data, pointMeta = [], range = null, allowedLabels = null) {
  const points = [];
  const meta = [];
  (labels || []).forEach((label, idx) => {
    if (!labelAllowed(label, range, allowedLabels)) return;
    const y = Array.isArray(data) ? data[idx] : null;
    if (!Number.isFinite(Number(y))) return;
    points.push({ x: String(label), y });
    meta.push(Array.isArray(pointMeta) ? pointMeta[idx] ?? null : null);
  });
  return { points, meta };
}

function convertDatasetToPointData(dataset, sourceLabels, range = null, allowedLabels = null) {
  const { points, meta } = datasetPointsForLabels(sourceLabels, dataset?.data, dataset?.pointMeta, range, allowedLabels);
  return {
    ...dataset,
    data: points,
    pointMeta: Array.isArray(dataset?.pointMeta) ? meta : dataset?.pointMeta
  };
}

function mergeChartOptions(target, source) {
  if (!target || !source || typeof source !== 'object') return;
  for (const [key, value] of Object.entries(source)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      target[key] ||= {};
      mergeChartOptions(target[key], value);
    } else {
      target[key] = value;
    }
  }
}

async function ensureWidgetChartEntry(widget) {
  const definition = getWidgetDefinition(widget?.type);
  if (!widget?.id || !definition || widget.collapsed) return null;
  if ((definition.mode || 'timeseries') === 'table') return chartInstances.get(widget.id) || null;
  const existing = chartInstances.get(widget.id);
  if (existing?.chart) return existing;

  const host = document.getElementById(`chart-${widget.id}`);
  if (!host) return null;

  const eventPort = Array.isArray(definition.eventContracts) && definition.eventContracts.length
    ? widgetEventBus.registerSource({
      tabId: activeTab()?.id || null,
      widgetId: widget.id,
      widgetType: widget.type,
      contracts: definition.eventContracts
    })
    : null;
  const chart = await createWidgetChartForDefinition(host, definition, {
    eventPort,
    onLegendVisibilityChange: () => {
      if (!['snapshot-series', 'timeseries-custom'].includes(definition.mode || 'timeseries')) return;
      syncHiddenSnapshotSeriesLabels(widget, chart);
      persistUiState();
    }
  });
  if (!chart) {
    eventPort?.destroy();
    return null;
  }
  const entry = {
    chart,
    mode: definition.mode || 'timeseries',
    metric: definition.metric,
    definition,
    widget,
    eventPort
  };
  chartInstances.set(widget.id, entry);
  return entry;
}

function destroyWidgetChartEntry(widgetId) {
  const entry = chartInstances.get(widgetId);
  if (!entry || entry.mode === 'table') return;
  if (entry.chart && typeof entry.chart.destroy === 'function') entry.chart.destroy();
  entry.eventPort?.destroy?.();
  chartInstances.delete(widgetId);
}

function updateWidgetCollapsedCard(card, widget) {
  card.classList.toggle('widget-card-collapsed', Boolean(widget.collapsed));
  const handle = card.querySelector('[data-widget-collapse-handle]');
  if (handle) {
    handle.setAttribute('aria-expanded', widget.collapsed ? 'false' : 'true');
    handle.setAttribute('title', `Double-click to ${widget.collapsed ? 'expand' : 'collapse'}`);
  }
}

async function renderWidgets() {
  const profileStart = performance.now();
  destroyCharts();
  const tab = activeTab();
  const renderTabId = tab?.id || null;
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
    normalizeWidgetPluginConfig(widget, appPluginManifests);

    grid.appendChild(createWidgetCard(widget, definition, {
      widgetExtensions: applicableWidgetExtensions(appPluginManifests, widget, definition)
    }));
  }

  const sidecar = document.createElement('aside');
  sidecar.className = 'widgets-history-sidecar';
  sidecar.setAttribute('data-history-sidecar', 'true');
  sidecar.hidden = true;
  sidecar.innerHTML = `
    <div class="widgets-history-sidecar-header">
      <span data-history-sidecar-title>history</span>
      <div class="widgets-history-sidecar-actions">
        <button type="button" class="btn widgets-history-sidecar-delete" data-history-sidecar-delete>delete unselected</button>
        <button type="button" class="btn btn-icon widgets-history-sidecar-close" data-history-sidecar-close aria-label="Close history panel">✕</button>
      </div>
    </div>
    <div class="widgets-history-sidecar-body" data-history-sidecar-body></div>
  `;

  root.replaceChildren(sidecar, grid);

  for (const widget of tab.widgets) {
    const definition = getWidgetDefinition(widget.type);
    if (!definition) continue;

    if ((definition.mode || 'timeseries') === 'table') {
      chartInstances.set(widget.id, {
        chart: null,
        mode: 'table',
        metric: null,
        definition,
        widget
      });
      continue;
    }

    await ensureWidgetChartEntry(widget);
    if (!isActiveTabId(renderTabId)) return;
  }

  root.querySelectorAll('[data-widget-id]').forEach((btn) => {
    btn.addEventListener('click', (evt) => {
      const wid = evt.target.getAttribute('data-widget-id');
      tab.widgets = tab.widgets.filter((w) => w.id !== wid);
      clearWidgetData(tab.id, wid);
      ensureTabHistoryPolicy(tab);
      renderWidgets();
      persistUiState();
    });
  });

  let draggedWidgetId = null;
  const isInteractiveWidgetControl = (node) => Boolean(
    node?.closest?.('input, textarea, select, option, button, [contenteditable="true"], label')
  );

  root.querySelectorAll('.widget-card[data-widget-card-id]').forEach((card) => {
    const cardWidgetId = card.dataset.widgetCardId;
    let canDragWidgetFromHeader = false;

    const setDragEnabled = (enabled) => {
      card.draggable = Boolean(enabled);
      if (enabled) {
        card.removeAttribute('data-drag-disabled');
      } else {
        card.setAttribute('data-drag-disabled', 'true');
      }
    };

    card.addEventListener('focusin', (evt) => {
      if (!isInteractiveWidgetControl(evt.target)) return;
      setDragEnabled(false);
    });

    card.addEventListener('focusout', () => {
      const activeInsideCard = card.contains(document.activeElement);
      if (!activeInsideCard) setDragEnabled(true);
    });

    card.addEventListener('pointerdown', (evt) => {
      canDragWidgetFromHeader = Boolean(evt.target.closest('.widget-title')) && !isInteractiveWidgetControl(evt.target);
      if (isInteractiveWidgetControl(evt.target)) setDragEnabled(false);
    });

    card.addEventListener('pointerup', () => {
      const activeInsideCard = card.contains(document.activeElement);
      if (!activeInsideCard) setDragEnabled(true);
      canDragWidgetFromHeader = false;
    });

    card.addEventListener('pointercancel', () => {
      canDragWidgetFromHeader = false;
    });

    card.querySelector('[data-widget-collapse-handle]')?.addEventListener('dblclick', (evt) => {
      if (isInteractiveWidgetControl(evt.target)) return;
      const target = tab.widgets.find((w) => w.id === cardWidgetId);
      if (!target) return;

      evt.preventDefault();
      target.collapsed = !target.collapsed;
      updateWidgetCollapsedCard(card, target);
      if (target.collapsed) {
        destroyWidgetChartEntry(target.id);
      } else {
        ensureWidgetChartEntry(target)
          .then(() => refreshWidget(target.id, { refreshDependents: false }))
          .catch((err) => console.error('Failed to expand widget chart', err));
      }
      persistUiState();
    });

    card.addEventListener('dragstart', (evt) => {
      if (isInteractiveWidgetControl(evt.target) || !canDragWidgetFromHeader) {
        evt.preventDefault();
        return;
      }
      draggedWidgetId = cardWidgetId;
      card.classList.add('is-dragging');
      evt.dataTransfer.effectAllowed = 'move';
      evt.dataTransfer.setData('text/plain', cardWidgetId);
    });

    card.addEventListener('dragend', () => {
      draggedWidgetId = null;
      canDragWidgetFromHeader = false;
      card.classList.remove('is-dragging');
      root.querySelectorAll('.widget-card.drag-over').forEach((x) => x.classList.remove('drag-over'));
      if (!card.contains(document.activeElement)) setDragEnabled(true);
    });

    card.addEventListener('dragover', (evt) => {
      evt.preventDefault();
      evt.dataTransfer.dropEffect = 'move';
      if (draggedWidgetId && draggedWidgetId !== cardWidgetId) card.classList.add('drag-over');
    });

    card.addEventListener('dragleave', () => {
      card.classList.remove('drag-over');
    });

    card.addEventListener('drop', (evt) => {
      evt.preventDefault();
      card.classList.remove('drag-over');

      const fromId = draggedWidgetId || evt.dataTransfer.getData('text/plain');
      const toId = cardWidgetId;
      if (!fromId || !toId || fromId === toId) return;

      const fromIdx = tab.widgets.findIndex((w) => w.id === fromId);
      const toIdx = tab.widgets.findIndex((w) => w.id === toId);
      if (fromIdx === -1 || toIdx === -1) return;

      const [moved] = tab.widgets.splice(fromIdx, 1);
      const insertAt = fromIdx < toIdx ? toIdx - 1 : toIdx;
      tab.widgets.splice(insertAt, 0, moved);

      renderWidgets();
      persistUiState();
    });
  });

  const widgetParamSelector = '[data-widget-param-widget-id][data-widget-param-name]';
  const widgetExtensionSelector = '[data-widget-extension-widget-id][data-widget-extension-plugin-id][data-widget-extension-control]';

  function setWidgetParamValue(wid, paramName, rawValue) {
    const target = tab.widgets.find((w) => w.id === wid);
    if (!target || !paramName) return false;

    target.config ||= {};
    const definition = getWidgetDefinition(target.type);
    const currentValue = target.config[paramName];
    const nextValue = normalizeWidgetParamValue(paramName, rawValue, currentValue, {
      strikeInputType: definition?.controls?.strikeInputType === 'text' ? 'text' : 'number'
    });
    target.config[paramName] = nextValue;
    return true;
  }

  root.querySelectorAll(widgetParamSelector).forEach((input) => {
    input.addEventListener('input', (evt) => {
      const wid = evt.target.dataset[WIDGET_PARAM_DATASET.WIDGET_ID];
      const paramName = evt.target.dataset[WIDGET_PARAM_DATASET.PARAM_NAME];
      const rawValue = evt.target.type === 'checkbox' ? evt.target.checked : evt.target.value;
      if (!setWidgetParamValue(wid, paramName, rawValue)) return;
      if (shouldRefreshOnWidgetParamChange(paramName)) {
        refreshWidget(wid).catch((err) => console.error('Failed to refresh widget param input', err));
      }
      schedulePersistUiState();
    });

    input.addEventListener('change', (evt) => {
      const wid = evt.target.dataset[WIDGET_PARAM_DATASET.WIDGET_ID];
      const paramName = evt.target.dataset[WIDGET_PARAM_DATASET.PARAM_NAME];
      const rawValue = evt.target.type === 'checkbox' ? evt.target.checked : evt.target.value;
      if (!setWidgetParamValue(wid, paramName, rawValue)) return;
      if (shouldRefreshOnWidgetParamChange(paramName)) {
        refreshWidget(wid).catch((err) => console.error('Failed to refresh widget param change', err));
      }
      persistUiState();
    });

    input.addEventListener('click', (evt) => {
      if (!evt.ctrlKey) return;

      const sourceWidgetId = evt.target.dataset[WIDGET_PARAM_DATASET.WIDGET_ID];
      const paramName = evt.target.dataset[WIDGET_PARAM_DATASET.PARAM_NAME];
      const rawValue = evt.target.type === 'checkbox' ? evt.target.checked : evt.target.value;
      if (!sourceWidgetId || !paramName) return;

      let hasAnyUpdates = false;
      for (const widget of tab.widgets) {
        if (widget.id === sourceWidgetId) continue;
        hasAnyUpdates = setWidgetParamValue(widget.id, paramName, rawValue) || hasAnyUpdates;
      }
      if (!hasAnyUpdates) return;

      root.querySelectorAll(`${widgetParamSelector}[data-widget-param-name="${paramName}"]`).forEach((otherInput) => {
        if (otherInput.type === 'checkbox') {
          otherInput.checked = Boolean(rawValue);
        } else {
          otherInput.value = rawValue;
        }
      });

      if (shouldRefreshOnWidgetParamChange(paramName)) {
        Promise.all(
          tab.widgets
            .filter((widget) => widget.id !== sourceWidgetId)
            .map((widget) => refreshWidget(widget.id))
        ).catch((err) => console.error('Failed to refresh broadcast widget params', err));
      }
      persistUiState();
    });
  });

  root.querySelectorAll(widgetExtensionSelector).forEach((input) => {
    input.addEventListener('change', (evt) => {
      const wid = evt.target.dataset.widgetExtensionWidgetId;
      const pluginId = evt.target.dataset.widgetExtensionPluginId;
      const controlName = evt.target.dataset.widgetExtensionControl;
      const target = tab.widgets.find((w) => w.id === wid);
      if (!target || !pluginId || !controlName) return;
      const definition = getWidgetDefinition(target.type);
      const extensions = applicableWidgetExtensions(appPluginManifests, target, definition);
      const extension = extensions.find((item) => item.pluginId === pluginId);
      const rawValue = evt.target.type === 'checkbox' ? evt.target.checked : evt.target.value;
      if (!writeWidgetExtensionControlValue(target, extension, controlName, rawValue)) return;
      persistUiState();
    });
  });

  const applyHistorySelection = (widgetId, changedInput = null) => {
    const target = tab.widgets.find((w) => w.id === widgetId);
    if (!target) return false;
    target.config ||= {};
    const checked = Array.from(root.querySelectorAll(`input[data-widget-history-option-widget-id="${widgetId}"]:checked`))
      .map((node) => node.value);
    if (changedInput?.value) {
      const prev = Array.isArray(target.config.historySnapshotTimes) ? target.config.historySnapshotTimes.map(String) : [];
      if (changedInput.checked) {
        target.config.historySnapshotTimes = [...prev.filter((time) => checked.includes(time) && time !== changedInput.value), changedInput.value];
      } else {
        target.config.historySnapshotTimes = prev.filter((time) => checked.includes(time) && time !== changedInput.value);
      }
    } else {
      target.config.historySnapshotTimes = checked;
    }
    return true;
  };

  const closeHistorySidecar = () => {
    historySidecarWidgetId = null;
    updateWidgetHistoryControls(root, tab);
  };

  root.querySelectorAll('[data-widget-history-toggle-widget-id]').forEach((toggleBtn) => {
    toggleBtn.addEventListener('click', (evt) => {
      const widgetId = evt.currentTarget.dataset.widgetHistoryToggleWidgetId;
      if (!widgetId) return;

      if (evt.ctrlKey) {
        const sourceChecked = Array.from(root.querySelectorAll(`input[data-widget-history-option-widget-id="${widgetId}"]:checked`))
          .map((node) => node.value);
        const sourceWidget = tab.widgets.find((widget) => widget.id === widgetId);
        const sourceCommonRange = shouldUseCommonHistoryStrikeRange(sourceWidget);
        const sourceHideCurrent = shouldHideCurrentSnapshotSeries(sourceWidget);
        let hasChanges = false;
        for (const widget of tab.widgets) {
          if (!String(widget?.type || '').startsWith('ndate-skew-')) continue;
          widget.config ||= {};
          const prev = Array.isArray(widget.config.historySnapshotTimes) ? widget.config.historySnapshotTimes : [];
          const next = [...sourceChecked];
          if (JSON.stringify(prev) !== JSON.stringify(next)) {
            widget.config.historySnapshotTimes = next;
            hasChanges = true;
          }
          if (widget.config.commonHistoryStrikeRange !== sourceCommonRange) {
            widget.config.commonHistoryStrikeRange = sourceCommonRange;
            hasChanges = true;
          }
          if (widget.config.hideCurrentSnapshotSeries !== sourceHideCurrent) {
            widget.config.hideCurrentSnapshotSeries = sourceHideCurrent;
            hasChanges = true;
          }
        }
        if (hasChanges) {
          updateWidgetHistoryControls(root, tab);
          refreshNDateWidgets().catch((err) => console.error('Failed to refresh nDate history broadcast', err));
          persistUiState();
        }
        return;
      }

      if (toggleBtn.disabled) return;
      historySidecarWidgetId = historySidecarWidgetId === widgetId ? null : widgetId;
      updateWidgetHistoryControls(root, tab);
    });
  });

  root.querySelector('[data-history-sidecar-body]')?.addEventListener('change', (evt) => {
    const commonRangeWidgetId = evt.target?.dataset?.widgetHistoryCommonRangeWidgetId;
    if (commonRangeWidgetId) {
      const target = tab.widgets.find((w) => w.id === commonRangeWidgetId);
      if (!target) return;
      target.config ||= {};
      target.config.commonHistoryStrikeRange = Boolean(evt.target.checked);
      refreshWidget(commonRangeWidgetId).catch((err) => console.error('Failed to refresh history common range', err));
      persistUiState();
      return;
    }

    const hideCurrentWidgetId = evt.target?.dataset?.widgetHistoryHideCurrentWidgetId;
    if (hideCurrentWidgetId) {
      const target = tab.widgets.find((w) => w.id === hideCurrentWidgetId);
      if (!target) return;
      target.config ||= {};
      target.config.hideCurrentSnapshotSeries = Boolean(evt.target.checked);
      refreshWidget(hideCurrentWidgetId).catch((err) => console.error('Failed to refresh history hide current', err));
      persistUiState();
      return;
    }

    const widgetId = evt.target?.dataset?.widgetHistoryOptionWidgetId;
    if (!widgetId) return;
    if (!applyHistorySelection(widgetId, evt.target)) return;
    updateWidgetHistoryControls(root, tab);
    refreshWidget(widgetId).catch((err) => console.error('Failed to refresh history selection', err));
    persistUiState();
  });

  root.querySelector('[data-history-sidecar-close]')?.addEventListener('click', closeHistorySidecar);
  root.querySelector('[data-history-sidecar-delete]')?.addEventListener('click', () => {
    const widget = tab.widgets.find((w) => w.id === historySidecarWidgetId);
    if (!widget) return;

    const selected = new Set(getSelectedHistorySnapshotTimes(widget));
    const history = Array.isArray(state.historyByTab[tab.id]) ? state.historyByTab[tab.id] : [];
    const latest = history[history.length - 1] || null;
    const latestTime = String(latest?.time || '');

    state.historyByTab[tab.id] = history.filter((snapshot) => {
      const time = String(snapshot?.time || '');
      if (!time) return false;
      if (time === latestTime) return true;
      return selected.has(time);
    });

    updateWidgetHistoryControls(root, tab);
    refreshCharts();
  });

  updateWidgetHistoryControls(root, tab);
  if (isActiveTabId(renderTabId)) refreshCharts();
  profileDuration('renderWidgets', profileStart, {
    tabId: renderTabId,
    widgets: tab.widgets?.length || 0
  });
}

function createWidgetRefreshContext(tab = activeTab()) {
  if (!tab) return null;
  const history = state.historyByTab[tab.id] || [];
  const latest = history[history.length - 1] || null;
  return {
    tab,
    history,
    latest,
    publishChartRuntime: () => {}
  };
}

async function refreshChartEntry(entry, context = createWidgetRefreshContext()) {
  const profileStart = performance.now();
  if (!entry || !context) return;
  const { chart, mode, metric, definition, widget } = entry;
  const { history, latest, publishChartRuntime } = context;
  if (widget?.collapsed || mode === 'table' || !chart) return;

  if (mode === 'snapshot-series' && typeof definition.buildSnapshotSeries === 'function') {
    const historicalComparisons = collectHistoricalComparisons(history, widget);

    const applySeriesToChart = (seriesToApply, widgetForSeries = widget) => {
      chart.data.labels = seriesToApply?.labels || [];

      if (Array.isArray(seriesToApply?.datasets) && seriesToApply.datasets.length) {
        chart.data.datasets = seriesToApply.datasets.map((dataset, idx) => ({
          label: dataset?.label || `Series ${idx + 1}`,
          data: Array.isArray(dataset?.data) ? dataset.data : [],
          borderWidth: 1,
          tension: 0.2,
          pointRadius: 0,
          pointHitRadius: 0,
          pointHoverRadius: 0,
          borderColor: dataset?.borderColor || definition.color || '#7aa2ff',
          pointMeta: Array.isArray(dataset?.pointMeta) ? dataset.pointMeta : [],
          tooltipFormatter: typeof dataset?.tooltipFormatter === 'function' ? dataset.tooltipFormatter : null
        }));
      } else {
        chart.data.datasets = [{
          label: definition.defaultTitle,
          data: seriesToApply?.values || [],
          borderWidth: 1,
          tension: 0.2,
          pointRadius: 0,
          pointHitRadius: 0,
          pointHoverRadius: 0,
          borderColor: definition.color || '#7aa2ff'
        }];
      }

      const sourceLabels = Array.isArray(chart.data.labels) ? chart.data.labels.map((label) => String(label)) : [];
      const rangeSpecs = chart.data.datasets.map((dataset) => ({
        labels: sourceLabels,
        data: dataset?.data
      }));
      const allLabels = new Set(sourceLabels);
      const historyDatasets = [];

      for (const comparison of historicalComparisons) {
        const historicalSeries = definition.buildSnapshotSeries(comparison.snapshot, widgetForSeries);
        if (!Array.isArray(historicalSeries?.labels) || !Array.isArray(historicalSeries?.datasets)) {
          const baseDataset = chart.data.datasets[0];
          if (!baseDataset) continue;
          const historicalLabels = (historicalSeries?.labels || []).map((label) => String(label));
          historicalLabels.forEach((label) => allLabels.add(label));
          rangeSpecs.push({
            labels: historicalLabels,
            data: Array.isArray(historicalSeries?.values) ? historicalSeries.values : []
          });
          historyDatasets.push({
            label: `${baseDataset.label} â€¢ ${comparison.label}`,
            data: Array.isArray(historicalSeries?.values) ? historicalSeries.values : [],
            borderWidth: 1,
            tension: 0.2,
            pointRadius: 0,
            pointHitRadius: 0,
            pointHoverRadius: 0,
            borderColor: comparison.historyColor || baseDataset.borderColor || definition.color || '#7aa2ff',
            borderDash: [6, 4],
            hiddenInLegend: true,
            sourceLabels: historicalLabels,
            pointMeta: [],
            tooltipFormatter: typeof baseDataset?.tooltipFormatter === 'function' ? baseDataset.tooltipFormatter : null
          });
          continue;
        }

        const historicalLabels = (historicalSeries.labels || []).map((label) => String(label));
        historicalLabels.forEach((label) => allLabels.add(label));
        for (let idx = 0; idx < chart.data.datasets.length; idx += 1) {
          const baseDataset = chart.data.datasets[idx];
          const seriesToUse = historicalSeries.datasets[idx] || historicalSeries.datasets.find((x) => x?.label === baseDataset.label);
          if (!seriesToUse) continue;
          rangeSpecs.push({
            labels: historicalLabels,
            data: Array.isArray(seriesToUse?.data) ? seriesToUse.data : []
          });
          historyDatasets.push({
            label: `${baseDataset.label} â€¢ ${comparison.label}`,
            data: Array.isArray(seriesToUse?.data) ? seriesToUse.data : [],
            borderWidth: 1,
            tension: 0.2,
            pointRadius: 0,
            pointHitRadius: 0,
            pointHoverRadius: 0,
            borderColor: comparison.historyColor || baseDataset.borderColor || definition.color || '#7aa2ff',
            borderDash: [6, 4],
            hiddenInLegend: true,
            baseDatasetIndex: idx,
            sourceLabels: historicalLabels,
            pointMeta: Array.isArray(seriesToUse?.pointMeta) ? seriesToUse.pointMeta : [],
            tooltipFormatter: typeof baseDataset?.tooltipFormatter === 'function' ? baseDataset.tooltipFormatter : null
          });
        }
      }

      return { allLabels, historyDatasets, rangeSpecs, sourceLabels };
    };

    let series = definition.buildSnapshotSeries(latest, widget);
    let built = applySeriesToChart(series);
    const useCommonStrikeRange = built.historyDatasets.length && shouldUseCommonHistoryStrikeRange(widget);
    const outerRange = useCommonStrikeRange ? outerNumericRange(built.rangeSpecs) : null;
    const seriesWidget = outerRange
      ? { ...widget, config: { ...(widget.config || {}), historyStrikeRangeBounds: outerRange } }
      : widget;

    if (outerRange) {
      series = definition.buildSnapshotSeries(latest, seriesWidget);
      built = applySeriesToChart(series, seriesWidget);
    }

    const hasMultipleBaseDatasets = chart.data.datasets.length > 1;
    const historyDatasets = built.historyDatasets;
    const baseDatasetsCount = chart.data.datasets.length;
    const sourceLabels = built.sourceLabels;
    const commonRange = outerRange;
    const targetLabels = sortChartLabels(Array.from(built.allLabels), sourceLabels)
      .filter((label) => labelAllowed(label, commonRange));
    chart.data.labels = targetLabels;
    chart.data.datasets = chart.data.datasets.map((dataset) => (
      convertDatasetToPointData(dataset, sourceLabels, commonRange)
    ));
    historyDatasets.forEach((dataset) => {
      const source = Array.isArray(dataset.sourceLabels) ? dataset.sourceLabels : [];
      delete dataset.sourceLabels;
      Object.assign(dataset, convertDatasetToPointData(dataset, source, commonRange));
    });

    chart.data.datasets.push(...historyDatasets);

    if (historyDatasets.length) {
      for (let idx = 0; idx < baseDatasetsCount; idx += 1) {
        const linked = [];
        for (let histIdx = baseDatasetsCount; histIdx < chart.data.datasets.length; histIdx += 1) {
          const dataset = chart.data.datasets[histIdx];
          if (dataset?.baseDatasetIndex === idx) linked.push(histIdx);
        }
        chart.data.datasets[idx].linkedHistoryIndices = linked;
      }
    }

    chart.options.plugins.legend.labels.generateLabels = (legendChart) => (
      (legendChart.data.datasets || []).map((dataset, datasetIndex) => ({
        text: dataset?.label || `Series ${datasetIndex + 1}`,
        datasetIndex,
        index: datasetIndex,
        hidden: !legendChart.isDatasetVisible(datasetIndex),
        strokeStyle: dataset?.borderColor || dataset?.backgroundColor || '#7aa2ff',
        fillStyle: dataset?.backgroundColor || dataset?.borderColor || '#7aa2ff',
        lineDash: Array.isArray(dataset?.borderDash) ? dataset.borderDash : []
      })).filter((item) => !legendChart.data.datasets[item.datasetIndex]?.hiddenInLegend)
    );
    chart.options.plugins.legend.display = hasMultipleBaseDatasets;
    applyHiddenSnapshotSeriesLabels(widget, chart);
    const baseVisibilityBeforeHideCurrent = chart.data.datasets
      .slice(0, baseDatasetsCount)
      .map((_, idx) => chart.isDatasetVisible(idx));
    if (historyDatasets.length && shouldHideCurrentSnapshotSeries(widget)) {
      for (let idx = 0; idx < baseDatasetsCount; idx += 1) {
        const linked = Array.isArray(chart.data.datasets[idx]?.linkedHistoryIndices)
          ? chart.data.datasets[idx].linkedHistoryIndices
          : [];
        linked.forEach((linkedIdx) => {
          if (!Number.isInteger(linkedIdx)) return;
          if (linkedIdx < 0 || linkedIdx >= chart.data.datasets.length) return;
          chart.setDatasetVisibility(linkedIdx, baseVisibilityBeforeHideCurrent[idx] !== false);
        });
        chart.setDatasetVisibility(idx, false);
      }
    } else {
      syncLinkedHistoryVisibility(chart);
    }
    chart.update('none');
    publishChartRuntime(entry);
    profileDuration('refreshChartEntry', profileStart, {
      widgetId: widget?.id,
      type: widget?.type,
      mode,
      datasets: chart.data.datasets?.length || 0,
      labels: chart.data.labels?.length || 0
    });
    return;
  }

  if (mode === 'timeseries-custom' && typeof definition.buildTimeSeries === 'function') {
    const series = definition.buildTimeSeries(history, widget);
    chart.data.labels = Array.isArray(series?.labels) ? series.labels : [];
    chart.data.datasets = (Array.isArray(series?.datasets) ? series.datasets : []).map((dataset, idx) => ({
      ...dataset,
      type: dataset?.type,
      yAxisID: dataset?.yAxisID,
      label: dataset?.label || `Series ${idx + 1}`,
      data: Array.isArray(dataset?.data) ? dataset.data : [],
      borderWidth: dataset?.borderWidth ?? 1,
      tension: dataset?.tension ?? 0.2,
      pointRadius: dataset?.pointRadius ?? 0,
      pointHitRadius: 0,
      pointHoverRadius: 0,
      borderColor: dataset?.borderColor || definition.color || '#7aa2ff',
      backgroundColor: dataset?.backgroundColor,
      borderDash: dataset?.borderDash,
      pointMeta: Array.isArray(dataset?.pointMeta) ? dataset.pointMeta : [],
      tooltipFormatter: typeof dataset?.tooltipFormatter === 'function' ? dataset.tooltipFormatter : null
    }));
    if (series?.chartOptions) mergeChartOptions(chart.options, series.chartOptions);
    chart.options.plugins.legend.display = chart.data.datasets.length > 1;
    chart.options.plugins.title ||= {};
    chart.options.plugins.title.display = Boolean(series?.title);
    chart.options.plugins.title.text = series?.title || '';
    applyHiddenSnapshotSeriesLabels(widget, chart);
    chart.update('none');
    publishChartRuntime(entry, series?.title || '');
    profileDuration('refreshChartEntry', profileStart, {
      widgetId: widget?.id,
      type: widget?.type,
      mode,
      datasets: chart.data.datasets?.length || 0,
      labels: chart.data.labels?.length || 0
    });
    return;
  }

  if (mode === 'timeseries-custom' && typeof definition.extractTimeSeriesValue === 'function') {
    chart.data.labels = history.map((x) => new Date(x.time).toLocaleTimeString());
    chart.data.datasets[0].data = history.map((x) => {
      const widgetSnapshot = x;
      return definition.extractTimeSeriesValue(widgetSnapshot, widget);
    });
    chart.options.plugins.legend.display = false;
    chart.update('none');
    publishChartRuntime(entry);
    profileDuration('refreshChartEntry', profileStart, {
      widgetId: widget?.id,
      type: widget?.type,
      mode,
      datasets: chart.data.datasets?.length || 0,
      labels: chart.data.labels?.length || 0
    });
    return;
  }

  chart.data.labels = history.map((x) => new Date(x.time).toLocaleTimeString());
  chart.data.datasets[0].data = history.map((x) => x[metric]);
  chart.options.plugins.legend.display = false;
  chart.update('none');
  publishChartRuntime(entry);
  profileDuration('refreshChartEntry', profileStart, {
    widgetId: widget?.id,
    type: widget?.type,
    mode,
    datasets: chart.data.datasets?.length || 0,
    labels: chart.data.labels?.length || 0
  });
}

async function refreshCharts() {
  const profileStart = performance.now();
  const tab = activeTab();
  if (!tab) return;
  const tabId = tab.id;
  await Promise.all(tab.widgets.map((widget) => ensureWidgetChartEntry(widget)));
  if (!isActiveTabId(tabId)) return;

  const activeWidgetIds = new Set((tab.widgets || []).map((widget) => widget.id));
  const history = state.historyByTab[tab.id] || [];
  const latest = history[history.length - 1] || null;
  const publishChartRuntime = () => {};

  const entries = Array.from(chartInstances.values())
    .filter((entry) => activeWidgetIds.has(entry?.widget?.id));
  const producerRenderTasks = [];
  for (const entry of entries) {
    const { chart, mode, metric, definition, widget } = entry;
    if (widget?.collapsed && mode !== 'table') continue;
    if (mode === 'table' && typeof definition.render === 'function' && !definition.consumesWidgetData) {
      if (definition.refreshOnDashboardRefresh === false && entry.hasRendered) continue;
      producerRenderTasks.push(renderTableWidgetEntry(entry, latest, history));
      continue;
    }
    if (mode === 'table') continue;

    if (mode === 'snapshot-series' && typeof definition.buildSnapshotSeries === 'function') {
      const widgetSnapshot = latest;
      const historicalComparisons = collectHistoricalComparisons(history, widget);

      const applySeriesToChart = (seriesToApply, widgetForSeries = widget) => {
        chart.data.labels = seriesToApply?.labels || [];

        if (Array.isArray(seriesToApply?.datasets) && seriesToApply.datasets.length) {
          chart.data.datasets = seriesToApply.datasets.map((dataset, idx) => ({
            label: dataset?.label || `Series ${idx + 1}`,
            data: Array.isArray(dataset?.data) ? dataset.data : [],
            borderWidth: 1,
            tension: 0.2,
            pointRadius: 0,
            pointHitRadius: 0,
            pointHoverRadius: 0,
            borderColor: dataset?.borderColor || definition.color || '#7aa2ff',
            pointMeta: Array.isArray(dataset?.pointMeta) ? dataset.pointMeta : [],
            tooltipFormatter: typeof dataset?.tooltipFormatter === 'function' ? dataset.tooltipFormatter : null
          }));
        } else {
          chart.data.datasets = [{
            label: definition.defaultTitle,
            data: seriesToApply?.values || [],
            borderWidth: 1,
            tension: 0.2,
            pointRadius: 0,
            pointHitRadius: 0,
            pointHoverRadius: 0,
            borderColor: definition.color || '#7aa2ff'
          }];
        }

        const sourceLabels = Array.isArray(chart.data.labels) ? chart.data.labels.map((label) => String(label)) : [];
        const rangeSpecs = chart.data.datasets.map((dataset) => ({
          labels: sourceLabels,
          data: dataset?.data
        }));
        const allLabels = new Set(sourceLabels);
        const historyDatasets = [];

        for (const comparison of historicalComparisons) {
          const historicalSeries = definition.buildSnapshotSeries(comparison.snapshot, widgetForSeries);
          if (!Array.isArray(historicalSeries?.labels) || !Array.isArray(historicalSeries?.datasets)) {
            const baseDataset = chart.data.datasets[0];
            if (!baseDataset) continue;
            const historicalLabels = (historicalSeries?.labels || []).map((label) => String(label));
            historicalLabels.forEach((label) => allLabels.add(label));
            rangeSpecs.push({
              labels: historicalLabels,
              data: Array.isArray(historicalSeries?.values) ? historicalSeries.values : []
            });
            historyDatasets.push({
              label: `${baseDataset.label} • ${comparison.label}`,
              data: Array.isArray(historicalSeries?.values) ? historicalSeries.values : [],
              borderWidth: 1,
              tension: 0.2,
              pointRadius: 0,
              pointHitRadius: 0,
              pointHoverRadius: 0,
              borderColor: comparison.historyColor || baseDataset.borderColor || definition.color || '#7aa2ff',
              borderDash: [6, 4],
              hiddenInLegend: true,
              sourceLabels: historicalLabels,
              pointMeta: [],
              tooltipFormatter: typeof baseDataset?.tooltipFormatter === 'function' ? baseDataset.tooltipFormatter : null
            });
            continue;
          }

          const historicalLabels = (historicalSeries.labels || []).map((label) => String(label));
          historicalLabels.forEach((label) => allLabels.add(label));
          for (let idx = 0; idx < chart.data.datasets.length; idx += 1) {
            const baseDataset = chart.data.datasets[idx];
            const seriesToUse = historicalSeries.datasets[idx] || historicalSeries.datasets.find((x) => x?.label === baseDataset.label);
            if (!seriesToUse) continue;
            rangeSpecs.push({
              labels: historicalLabels,
              data: Array.isArray(seriesToUse?.data) ? seriesToUse.data : []
            });
            historyDatasets.push({
              label: `${baseDataset.label} • ${comparison.label}`,
              data: Array.isArray(seriesToUse?.data) ? seriesToUse.data : [],
              borderWidth: 1,
              tension: 0.2,
              pointRadius: 0,
              pointHitRadius: 0,
              pointHoverRadius: 0,
              borderColor: comparison.historyColor || baseDataset.borderColor || definition.color || '#7aa2ff',
              borderDash: [6, 4],
              hiddenInLegend: true,
              baseDatasetIndex: idx,
              sourceLabels: historicalLabels,
              pointMeta: Array.isArray(seriesToUse?.pointMeta) ? seriesToUse.pointMeta : [],
              tooltipFormatter: typeof baseDataset?.tooltipFormatter === 'function' ? baseDataset.tooltipFormatter : null
            });
          }
        }

        return { allLabels, historyDatasets, rangeSpecs, sourceLabels };
      };

      let series = definition.buildSnapshotSeries(widgetSnapshot, widget);
      let built = applySeriesToChart(series);
      const useCommonStrikeRange = built.historyDatasets.length && shouldUseCommonHistoryStrikeRange(widget);
      const outerRange = useCommonStrikeRange ? outerNumericRange(built.rangeSpecs) : null;
      const seriesWidget = outerRange
        ? { ...widget, config: { ...(widget.config || {}), historyStrikeRangeBounds: outerRange } }
        : widget;

      if (outerRange) {
        series = definition.buildSnapshotSeries(widgetSnapshot, seriesWidget);
        built = applySeriesToChart(series, seriesWidget);
      }

      const hasMultipleBaseDatasets = chart.data.datasets.length > 1;
      const historyDatasets = built.historyDatasets;
      const baseDatasetsCount = chart.data.datasets.length;
      const sourceLabels = built.sourceLabels;
      const commonRange = outerRange;
      const targetLabels = sortChartLabels(Array.from(built.allLabels), sourceLabels)
        .filter((label) => labelAllowed(label, commonRange));
      chart.data.labels = targetLabels;
      chart.data.datasets = chart.data.datasets.map((dataset) => (
        convertDatasetToPointData(dataset, sourceLabels, commonRange)
      ));
      historyDatasets.forEach((dataset) => {
        const source = Array.isArray(dataset.sourceLabels) ? dataset.sourceLabels : [];
        delete dataset.sourceLabels;
        Object.assign(dataset, convertDatasetToPointData(dataset, source, commonRange));
      });

      chart.data.datasets.push(...historyDatasets);

      if (historyDatasets.length) {
        for (let idx = 0; idx < baseDatasetsCount; idx += 1) {
          const linked = [];
          for (let histIdx = baseDatasetsCount; histIdx < chart.data.datasets.length; histIdx += 1) {
            const dataset = chart.data.datasets[histIdx];
            if (dataset?.baseDatasetIndex === idx) linked.push(histIdx);
          }
          chart.data.datasets[idx].linkedHistoryIndices = linked;
        }
      }

      chart.options.plugins.legend.labels.generateLabels = (legendChart) => (
        (legendChart.data.datasets || []).map((dataset, datasetIndex) => ({
          text: dataset?.label || `Series ${datasetIndex + 1}`,
          datasetIndex,
          index: datasetIndex,
          hidden: !legendChart.isDatasetVisible(datasetIndex),
          strokeStyle: dataset?.borderColor || dataset?.backgroundColor || '#7aa2ff',
          fillStyle: dataset?.backgroundColor || dataset?.borderColor || '#7aa2ff',
          lineDash: Array.isArray(dataset?.borderDash) ? dataset.borderDash : []
        })).filter((item) => !legendChart.data.datasets[item.datasetIndex]?.hiddenInLegend)
      );
      chart.options.plugins.legend.display = hasMultipleBaseDatasets;
      applyHiddenSnapshotSeriesLabels(widget, chart);
      const baseVisibilityBeforeHideCurrent = chart.data.datasets
        .slice(0, baseDatasetsCount)
        .map((_, idx) => chart.isDatasetVisible(idx));
      if (historyDatasets.length && shouldHideCurrentSnapshotSeries(widget)) {
        for (let idx = 0; idx < baseDatasetsCount; idx += 1) {
          const linked = Array.isArray(chart.data.datasets[idx]?.linkedHistoryIndices)
            ? chart.data.datasets[idx].linkedHistoryIndices
            : [];
          linked.forEach((linkedIdx) => {
            if (!Number.isInteger(linkedIdx)) return;
            if (linkedIdx < 0 || linkedIdx >= chart.data.datasets.length) return;
            chart.setDatasetVisibility(linkedIdx, baseVisibilityBeforeHideCurrent[idx] !== false);
          });
          chart.setDatasetVisibility(idx, false);
        }
      } else {
        syncLinkedHistoryVisibility(chart);
      }
      chart.update('none');
      publishChartRuntime(entry);
      continue;
    }

    if (mode === 'timeseries-custom' && typeof definition.buildTimeSeries === 'function') {
      const series = definition.buildTimeSeries(history, widget);
      chart.data.labels = Array.isArray(series?.labels) ? series.labels : [];
      chart.data.datasets = (Array.isArray(series?.datasets) ? series.datasets : []).map((dataset, idx) => ({
        ...dataset,
        type: dataset?.type,
        yAxisID: dataset?.yAxisID,
        label: dataset?.label || `Series ${idx + 1}`,
        data: Array.isArray(dataset?.data) ? dataset.data : [],
        borderWidth: dataset?.borderWidth ?? 1,
        tension: dataset?.tension ?? 0.2,
        pointRadius: dataset?.pointRadius ?? 0,
        pointHitRadius: 0,
        pointHoverRadius: 0,
        borderColor: dataset?.borderColor || definition.color || '#7aa2ff',
        backgroundColor: dataset?.backgroundColor,
        borderDash: dataset?.borderDash,
        pointMeta: Array.isArray(dataset?.pointMeta) ? dataset.pointMeta : [],
        tooltipFormatter: typeof dataset?.tooltipFormatter === 'function' ? dataset.tooltipFormatter : null
      }));
      if (series?.chartOptions) mergeChartOptions(chart.options, series.chartOptions);
      chart.options.plugins.legend.display = chart.data.datasets.length > 1;
      chart.options.plugins.title ||= {};
      chart.options.plugins.title.display = Boolean(series?.title);
      chart.options.plugins.title.text = series?.title || '';
      applyHiddenSnapshotSeriesLabels(widget, chart);
      chart.update('none');
      publishChartRuntime(entry, series?.title || '');
      continue;
    }

    if (mode === 'timeseries-custom' && typeof definition.extractTimeSeriesValue === 'function') {
      chart.data.labels = history.map((x) => new Date(x.time).toLocaleTimeString());
      chart.data.datasets[0].data = history.map((x) => {
        const widgetSnapshot = x;
        return definition.extractTimeSeriesValue(widgetSnapshot, widget);
      });
      chart.options.plugins.legend.display = false;
      chart.update('none');
      publishChartRuntime(entry);
      continue;
    }

    chart.data.labels = history.map((x) => new Date(x.time).toLocaleTimeString());
    chart.data.datasets[0].data = history.map((x) => x[metric]);
    chart.options.plugins.legend.display = false;
    chart.update('none');
    publishChartRuntime(entry);
  }

  await Promise.all(producerRenderTasks);
  if (!isActiveTabId(tabId)) return;

  const consumerRenderTasks = [];
  for (const entry of entries) {
    const { mode, definition } = entry;
    if (mode === 'table' && typeof definition.render === 'function' && definition.consumesWidgetData) {
      consumerRenderTasks.push(renderTableWidgetEntry(entry, latest, history));
    }
  }
  await Promise.all(consumerRenderTasks);
  profileDuration('refreshCharts', profileStart, {
    tabId,
    entries: entries.length,
    producers: producerRenderTasks.length,
    consumers: consumerRenderTasks.length,
    history: history.length
  });
}

async function renderTableWidgetEntry(entry, latest, history) {
  const profileStart = performance.now();
  const { mode, definition, widget } = entry || {};
  if (mode !== 'table' || typeof definition?.render !== 'function' || !widget?.id) return;

  const target = document.getElementById(`widget-body-${widget.id}`);
  if (!target) return;
  const tab = activeTab();
  let publishedStructuredData = false;

  await definition.render({
    container: target,
    snapshot: latest,
    history,
    widgets: tab?.widgets || [],
    widgetData: {
      publish: (data) => {
        publishedStructuredData = true;
        publishWidgetData(tab?.id, widget.id, data, latest?.time || null);
      },
      clear: () => clearWidgetData(tab?.id, widget.id),
      readByType: (type) => readWidgetDataByType(tab, type)
    },
    widget,
    onConfigChange: () => {
      persistUiState();
      refreshSingleTableWidget(widget.id)
        .then(() => {
          if (widget.type === 'atm-straddle') return refreshVolUpfrontWidgets();
          return null;
        })
        .catch((err) => console.error('Failed to refresh table widget', err));
    },
    onConfigBroadcast: (paramName, value) => {
      broadcastTableWidgetConfig(widget.id, paramName, value);
    }
  });
  if (!publishedStructuredData) {
    publishMcpWidgetRuntimeData(tab?.id, widget.id, {
      kind: 'table',
      mode: 'table',
      type: widget.type,
      status: 'no_data_contract',
      title: widget.title || definition.defaultTitle || widget.type,
      config: { ...(widget.config || {}) },
      sourceSnapshotTime: latest?.time || null,
      message: 'This table widget rendered in the UI but did not publish a structured data contract.'
    });
  }
  entry.hasRendered = true;
  profileDuration('renderTableWidgetEntry', profileStart, {
    widgetId: widget?.id,
    type: widget?.type,
    history: Array.isArray(history) ? history.length : 0
  });
}

async function refreshSingleTableWidget(widgetId) {
  const tab = activeTab();
  if (!tab || !widgetId) return;
  const tabId = tab.id;

  const entry = chartInstances.get(widgetId);
  if (!entry || entry.mode !== 'table') return;

  const history = state.historyByTab[tab.id] || [];
  const latest = history[history.length - 1] || null;
  if (!isActiveTabId(tabId)) return;
  await renderTableWidgetEntry(entry, latest, history);
}

async function refreshWidget(widgetId, options = {}) {
  const tab = activeTab();
  if (!tab || !widgetId) return;
  const tabId = tab.id;

  const entry = chartInstances.get(widgetId);
  if (!entry) return;

  const context = createWidgetRefreshContext(tab);
  if (!context) return;
  if (!isActiveTabId(tabId)) return;

  if (entry.mode === 'table') {
    await renderTableWidgetEntry(entry, context.latest, context.history);
  } else {
    await refreshChartEntry(entry, context);
  }

  if (options.refreshDependents === false) return;
  if (entry.widget?.type === 'atm-straddle') {
    await refreshVolUpfrontWidgets();
  }
}

async function refreshNDateWidgets() {
  const tab = activeTab();
  if (!tab) return;
  const tabId = tab.id;

  const context = createWidgetRefreshContext(tab);
  if (!context) return;
  if (!isActiveTabId(tabId)) return;

  const tasks = Array.from(chartInstances.values())
    .filter((entry) => String(entry?.widget?.type || '').startsWith('ndate-skew-'))
    .map((entry) => refreshChartEntry(entry, context));
  await Promise.all(tasks);
}

function broadcastTableWidgetConfig(sourceWidgetId, paramName, value) {
  const tab = activeTab();
  if (!tab || !sourceWidgetId || !paramName) return;

  const sourceWidget = tab.widgets.find((widget) => widget.id === sourceWidgetId);
  if (!sourceWidget) return;

  const updatedWidgetIds = [];
  for (const widget of tab.widgets) {
    if (widget.id === sourceWidgetId || widget.type !== sourceWidget.type) continue;
    widget.config ||= {};
    widget.config[paramName] = value;
    updatedWidgetIds.push(widget.id);
  }

  if (!updatedWidgetIds.length) return;
  persistUiState();
  Promise.all(updatedWidgetIds.map((widgetId) => refreshSingleTableWidget(widgetId)))
    .then(() => {
      if (sourceWidget.type === 'atm-straddle') return refreshVolUpfrontWidgets();
      return null;
    })
    .catch((err) => console.error('Failed to broadcast table widget config', err));
}

async function refreshVolUpfrontWidgets() {
  const tab = activeTab();
  if (!tab) return;
  const tabId = tab.id;
  if (!isActiveTabId(tabId)) return;

  const tasks = [];
  for (const widget of tab.widgets || []) {
    if (widget.type === 'vol-upfront') tasks.push(refreshSingleTableWidget(widget.id));
  }
  await Promise.all(tasks);
}

function tickTabIfActive(tabId) {
  if (!isActiveTabId(tabId)) return;
  const tab = activeTab();
  const root = $('widgetsRoot');
  if (tab && root) updateWidgetHistoryControls(root, tab);
  refreshCharts();
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
  persistUiState();
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
      expiryStart: defaultExpiry(),
      expiryEnd: '',
      yahooSymbol: 'SPY',
      pollSec: 5,
      keepPoints: 200,
      saveRawSnapshots: true,
      compactHistorySnapshots: true
    },
    widgets: []
  };

  state.tabs.push(tab);
  tabStatus[id] = 'ready';
  state.activeTabId = id;
  applyTabToForm(tab);
  renderTabs();
  renderWidgets();
  updatePollingControlsForActiveTab();
  syncDataSourcesToMain().catch((err) => console.warn('Failed to sync added datasource', err));
  persistUiState();
}

async function tickTab(tabId) {
  const tickStart = performance.now();
  const tab = state.tabs.find((x) => x.id === tabId);
  if (!tab) return;
  if (tabTickInFlight.has(tabId)) return;
  tabTickInFlight.add(tabId);

  const provider = providers[tab.providerKey];
  if (!provider) {
    setTabStatus(tabId, `Unknown provider: ${tab.providerKey}`);
    tabTickInFlight.delete(tabId);
    return;
  }

  try {
    setTabStatus(tabId, `Loading snapshot (${tab.title})...`);
    const point = await profileMeasure('tick:fetchSnapshot', {
      tabId,
      providerKey: tab.providerKey,
      title: tab.title
    }, () => provider.fetchSnapshot(tab.providerConfig, skewMetrics));
    if (shouldSaveRawSnapshots(tab)) {
      const rawStart = performance.now();
      saveRawSnapshotDeferred({
        tab: {
          id: tab.id,
          title: tab.title,
          providerKey: tab.providerKey,
          providerConfig: tab.providerConfig
        },
        snapshot: point
      });
      profileDuration('tick:rawSnapshotEnqueue', rawStart, { tabId, providerKey: tab.providerKey });
    }

    const policyStart = performance.now();
    ensureTabHistoryPolicy(tab);
    if (!tabSupportsHistorySnapshots(tab)) {
      profileDuration('tick:historyPolicy', policyStart, { tabId, supportsHistory: false });
      const renderStart = performance.now();
      tickTabIfActive(tabId);
      profileDuration('tick:activeRenderTrigger', renderStart, { tabId, active: isActiveTabId(tabId) });
      setTabStatus(tabId, `ok • ${tab.title} • history disabled (no history-input chart)`);
      profileDuration('tick:total', tickStart, { tabId, providerKey: tab.providerKey, historyDisabled: true });
      return;
    }
    profileDuration('tick:historyPolicy', policyStart, { tabId, supportsHistory: true });

    const trimStart = performance.now();
    const storedPoint = shouldCompactHistorySnapshots(tab)
      ? trimSnapshotForWidgets(point, tab)
      : point;
    profileDuration('tick:trimSnapshot', trimStart, {
      tabId,
      compact: shouldCompactHistorySnapshots(tab),
      expiries: storedPoint?.byExpiry ? Object.keys(storedPoint.byExpiry).length : 0
    });
    state.historyByTab[tab.id].push(storedPoint);

    const keepStart = performance.now();
    const keep = Math.max(20, Number(tab.providerConfig.keepPoints) || 200);
    while (state.historyByTab[tab.id].length > keep) {
      state.historyByTab[tab.id].shift();
    }
    profileDuration('tick:historyKeep', keepStart, { tabId, keep, history: state.historyByTab[tab.id].length });

    const renderStart = performance.now();
    tickTabIfActive(tabId);
    profileDuration('tick:activeRenderTrigger', renderStart, { tabId, active: isActiveTabId(tabId) });
    const updatedAt = formatStatusUpdateTime(point.time);
    if (point.theBlock?.latestDate) {
      const chartCount = Object.keys(point.theBlock?.charts || {}).length;
      setTabStatus(tabId, `ok • ${tab.title} • updated=${updatedAt} • The Block charts=${chartCount} • latest=${point.theBlock.latestDate}`);
    } else {
      setTabStatus(
        tabId,
        `ok • ${tab.title} • updated=${updatedAt} • px=${point.px?.toFixed(3) ?? 'n/a'} • lower=${point.lower ?? 'n/a'} upper=${point.upper ?? 'n/a'}`
      );
    }
    const persistStart = performance.now();
    persistHistoryPoint(tab.id, storedPoint, keep);
    profileDuration('tick:persistHistoryPointEnqueue', persistStart, { tabId });
    profileDuration('tick:total', tickStart, { tabId, providerKey: tab.providerKey, history: state.historyByTab[tab.id]?.length || 0 });
  } catch (err) {
    setTabStatus(tabId, `error • ${tab.title}: ${err?.message || err}`);
    profileDuration('tick:error', tickStart, { tabId, providerKey: tab.providerKey, message: err?.message || String(err) });
  } finally {
    tabTickInFlight.delete(tabId);
  }
}

function startTabPolling(tabId) {
  const tab = state.tabs.find((x) => x.id === tabId);
  if (!tab) return;
  stopTabPolling(tabId);
  const poll = Math.max(1, Number(tab.providerConfig.pollSec) || 5);
  tickTab(tabId);
  const timer = setInterval(() => tickTab(tabId), poll * 1000);
  tabTimers.set(tabId, timer);
}

function stopTabPolling(tabId) {
  const timer = tabTimers.get(tabId);
  if (timer) clearInterval(timer);
  tabTimers.delete(tabId);
  tabTickInFlight.delete(tabId);
}

async function executeDataSourceCommand(tabId, command) {
  const tab = state.tabs.find((item) => item.id === tabId);
  if (!tab) return;
  if (command === 'start') {
    startTabPolling(tab.id);
  } else if (command === 'stop') {
    stopTabPolling(tab.id);
    setTabStatus(tab.id, 'stopped');
  } else if (command === 'refresh') {
    if (tabRefreshInFlight.has(tab.id)) return;
    tabRefreshInFlight.add(tab.id);
    updatePollingControlsForActiveTab();
    try {
      await tickTab(tab.id);
    } finally {
      tabRefreshInFlight.delete(tab.id);
    }
  }
  updatePollingControlsForActiveTab();
  syncDataSourcesToMain().catch((err) => console.warn('Failed to sync datasource command state', err));
}

async function requestDataSourceCommand(tabId, command) {
  if (typeof window.appBridge?.runDataSourceCommand === 'function') {
    const result = await window.appBridge.runDataSourceCommand({ tabId, command });
    if (result?.error) console.warn('DataSource command failed', result.error);
    updatePollingControlsForActiveTab();
    return result;
  }
  await executeDataSourceCommand(tabId, command);
  return { ok: true, running: tabTimers.has(tabId) };
}

function start() {
  const tab = activeTab();
  if (!tab) return;
  requestDataSourceCommand(tab.id, 'start').catch((err) => console.warn('Failed to start datasource', err));
}

function stop() {
  const tab = activeTab();
  if (!tab) return;
  requestDataSourceCommand(tab.id, 'stop').catch((err) => console.warn('Failed to stop datasource', err));
}

async function refreshActiveTabOnce() {
  const tab = activeTab();
  if (!tab) return;
  await requestDataSourceCommand(tab.id, 'refresh');
}

function clearActiveTabSnapshot() {
  const tab = activeTab();
  if (!tab) return;

  state.historyByTab[tab.id] = [];
  refreshCharts();
  setTabStatus(tab.id, `snapshot cleared • ${tab.title}`);
}

function bindEvents() {
  window.addEventListener('keydown', (evt) => {
    if (!evt.ctrlKey || !evt.shiftKey || String(evt.key).toLowerCase() !== 'p') return;
    evt.preventDefault();
    exportProfilerToStatus();
  });

  $('startBtn').addEventListener('click', start);
  $('stopBtn').addEventListener('click', stop);
  $('refreshBtn').addEventListener('click', refreshActiveTabOnce);
  $('clearSnapshotBtn').addEventListener('click', clearActiveTabSnapshot);
  $('addTabBtn').addEventListener('click', addTab);
  $('addWidgetBtn').addEventListener('click', () => addWidget($('widgetTypeSelect').value));
  $('toggleConfigBtn').addEventListener('click', () => {
    const body = $('configBody');
    const collapsed = body.classList.toggle('is-collapsed');
    const toggleBtn = $('toggleConfigBtn');
    toggleBtn.textContent = collapsed ? '▾' : '▴';
    toggleBtn.setAttribute('title', collapsed ? 'Show config' : 'Hide config');
    toggleBtn.setAttribute('aria-label', collapsed ? 'Show config' : 'Hide config');
    toggleBtn.setAttribute('aria-expanded', String(!collapsed));
  });
  $('tabRenameAction').addEventListener('click', () => {
    openRenameTabModal(tabContextTargetId);
    hideTabContextMenu();
  });
  $('tabDeleteAction').addEventListener('click', () => {
    deleteTabById(tabContextTargetId);
    hideTabContextMenu();
  });
  document.addEventListener('pointerdown', (evt) => {
    if (!evt.target.closest('#tabContextMenu') && !evt.target.closest('.tab')) {
      hideTabContextMenu();
    }
  });
  document.addEventListener('contextmenu', (evt) => {
    if (!evt.target.closest('.tab')) hideTabContextMenu();
  });
  $('renameTabSaveBtn').addEventListener('click', () => {
    renameTabById(renameTargetTabId, $('renameTabInput').value);
    closeRenameTabModal();
  });
  $('renameTabCancelBtn').addEventListener('click', closeRenameTabModal);
  $('renameTabInput').addEventListener('keydown', (evt) => {
    if (evt.key === 'Enter') {
      renameTabById(renameTargetTabId, $('renameTabInput').value);
      closeRenameTabModal();
    }
    if (evt.key === 'Escape') closeRenameTabModal();
  });
  $('renameTabModal').addEventListener('click', (evt) => {
    if (evt.target === $('renameTabModal')) closeRenameTabModal();
  });

  ['providerKey', 'apiBase', 'ticker', 'root', 'expiryStart', 'expiryEnd', 'yahooSymbol', 'pollSec', 'keepPoints', 'saveRawSnapshots', 'compactHistorySnapshots'].forEach((id) => {
    $(id).addEventListener('change', () => {
      const tab = activeTab();
      if (!tab) return;
      readFormToTab(tab);
      if (id === 'providerKey') updateProviderConfigVisibility(tab.providerKey);
      persistUiState();
      if (tabTimers.has(tab.id)) startTabPolling(tab.id);
      syncDataSourcesToMain().catch((err) => console.warn('Failed to sync datasource config', err));
    });
  });

  $('dataSourceLifecycleControls')?.addEventListener('change', (evt) => {
    const input = evt.target;
    const lifecycleId = input?.dataset?.lifecycleId;
    const controlName = input?.dataset?.lifecycleControl;
    const tab = activeTab();
    if (!tab || !lifecycleId || !controlName) return;
    const control = lifecycleControlFor(tab, lifecycleId, controlName, input.type);
    const rawValue = control.type === 'time-list'
      ? readTimeListInputs(tab, lifecycleId, controlName)
      : (input.type === 'checkbox' ? Boolean(input.checked) : input.value);
    const normalized = normalizeLifecycleControlValue(control, rawValue);
    if (control.type === 'time' && input.type !== 'checkbox') input.value = normalized;
    writeLifecycleSettings(tab, lifecycleId, controlName, normalized);
  });

  $('dataSourceLifecycleControls')?.addEventListener('click', (evt) => {
    const button = evt.target.closest('button');
    const tab = activeTab();
    if (!button || !tab) return;
    const lifecycleId = button.dataset.lifecycleId;
    const addControlName = button.dataset.lifecycleTimeListAdd;
    const removeControlName = button.dataset.lifecycleTimeListRemove;
    if (lifecycleId && addControlName) {
      const list = button.closest('.lifecycle-time-list-field')?.querySelector('.lifecycle-time-list');
      if (!list) return;
      const index = list.querySelectorAll('input[data-lifecycle-time-list-index]').length;
      list.appendChild(createLifecycleTimeListRow(
        lifecycleId,
        addControlName,
        addControlName,
        '',
        index
      ));
      list.querySelector(`input[data-lifecycle-time-list-index="${index}"]`)?.focus();
      return;
    }
    if (lifecycleId && removeControlName) {
      const index = Number(button.dataset.lifecycleTimeListIndex);
      const current = readTimeListInputs(tab, lifecycleId, removeControlName);
      const next = current.filter((_item, idx) => idx !== index);
      writeLifecycleSettings(tab, lifecycleId, removeControlName, next);
    }
  });
}

function bindDataSourceLifecycleBridge() {
  window.appBridge?.onDataSourceCommand?.(async (message) => {
    try {
      await executeDataSourceCommand(message?.tabId, message?.command);
      window.appBridge.sendDataSourceCommandResult?.({
        requestId: message?.requestId,
        ok: true,
        running: tabTimers.has(message?.tabId)
      });
    } catch (err) {
      window.appBridge.sendDataSourceCommandResult?.({
        requestId: message?.requestId,
        ok: false,
        error: err?.message || String(err),
        running: tabTimers.has(message?.tabId)
      });
    }
  });

  window.appBridge?.onDataSourceConfigPatch?.((message) => {
    const tab = state.tabs.find((item) => item.id === message?.tabId);
    if (!tab) return;
    tab.providerConfig = normalizeProviderConfig({
      ...(tab.providerConfig || {}),
      ...(message.partial || {})
    });
    if (tab.id === state.activeTabId) applyTabToForm(tab);
    persistUiState();
  });

  window.appBridge?.onDataSourceLifecycleUiUpdated?.((message) => {
    updateLifecycleUiFromResponse(message);
    renderDataSourceLifecycleControls(activeTab());
  });
}

async function init() {
  profilerEnabled = Boolean(await window.appBridge.isProfilerEnabled?.());
  bindMcpRuntimeBridge();
  bindDataSourceLifecycleBridge();
  bindWidgetEventSubscribers();
  populateWidgetTypeSelect();
  bindEvents();
  const loaded = await window.appBridge.loadState();
  state.tabs = loaded.tabs || [];
  state.activeTabId = loaded.activeTabId || state.tabs[0]?.id;
  state.historyByTab = loaded.historyByTab && typeof loaded.historyByTab === 'object'
    ? loaded.historyByTab
    : {};

  if (!state.tabs.length) addTab();

  for (const tab of state.tabs) {
    tab.providerConfig = normalizeProviderConfig(tab.providerConfig || {});
    ensureTabHistoryPolicy(tab);
    if (!tab.providerConfig.expiryStart) tab.providerConfig.expiryStart = tab.providerConfig.expiry || defaultExpiry();
    if (tab.providerConfig.expiryEnd == null) tab.providerConfig.expiryEnd = '';
    for (const widget of tab.widgets || []) {
      widget.config ||= {};
      if (widget.type === 'tail-skew-line' && widget.config.tailSteps == null) {
        widget.config.tailSteps = Math.max(1, Number(tab.providerConfig.tailSteps) || 3);
      }
      if (!widget.config.expiryStart && widget.config.expiry) {
        widget.config.expiryStart = widget.config.expiry;
      }
    }
    trimHistoryForTab(tab);
  }

  if (!state.activeTabId) state.activeTabId = state.tabs[0].id;

  applyTabToForm(activeTab());
  renderTabs();
  renderWidgets();
  updatePollingControlsForActiveTab();
  setTabStatus(state.activeTabId, 'ready');
  await syncDataSourcesToMain();
  if (profilerEnabled) {
    console.info('[IS-VOL profiler] enabled: window.isVolProfiler.summary(), window.isVolProfiler.export(), window.isVolProfiler.clear()');
  }
}

init();
