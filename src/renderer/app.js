import { TradingViewProvider } from '../shared/tradingview-provider.js';
import { TheBlockProvider } from '../shared/theblock-provider.js';
import { getWidgetDefinition, widgetDefinitions } from './widgets/index.js';
import { createWidgetCard, createWidgetChart } from './widgets/widget-renderers.js';
import { skewMetrics } from './widgets/metrics.js';
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
  tradingview: new TradingViewProvider(),
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
let tabContextTargetId = null;
let renameTargetTabId = null;
let draggedTabId = null;
let historySidecarWidgetId = null;

const $ = (id) => document.getElementById(id);
const HISTORY_SNAPSHOT_PALETTE = ['#7dffb3', '#7aa2ff', '#f97316', '#eab308', '#d946ef', '#06b6d4', '#ef4444', '#f472b6'];

function historySnapshotColor(idx) {
  return HISTORY_SNAPSHOT_PALETTE[idx % HISTORY_SNAPSHOT_PALETTE.length];
}

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

function persist() {
  window.appBridge.saveState({
    activeTabId: state.activeTabId,
    tabs: state.tabs,
    historyByTab: state.historyByTab
  });
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
      persist();
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
      persist();
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
  persist();
}

function renameTabById(tabId, nextTitleRaw) {
  const tab = state.tabs.find((x) => x.id === tabId);
  if (!tab) return;
  const trimmed = String(nextTitleRaw || '').trim();
  if (!trimmed) return;
  tab.title = trimmed;
  renderTabs();
  persist();
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
  for (const { chart, definition, widget } of chartInstances.values()) {
    if (chart && typeof chart.destroy === 'function') chart.destroy();
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

function dashboardRuntimeSnapshot() {
  return createDashboardRuntimeSnapshot({
    state,
    widgetDefinitions,
    getRuntimeData: (tabId, widgetId) => mcpRuntimeStore.get(tabId, widgetId)
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

    if (widget.collapsed) continue;

    const ctx = document.getElementById(`canvas-${widget.id}`)?.getContext('2d');
    if (!ctx) continue;

    const chart = createWidgetChart(ctx, definition, {
      onLegendVisibilityChange: () => {
        if (!['snapshot-series', 'timeseries-custom'].includes(definition.mode || 'timeseries')) return;
        syncHiddenSnapshotSeriesLabels(widget, chart);
        persist();
      }
    });
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
      clearWidgetData(tab.id, wid);
      ensureTabHistoryPolicy(tab);
      renderWidgets();
      persist();
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
      renderWidgets();
      persist();
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
      persist();
    });
  });

  const widgetParamSelector = '[data-widget-param-widget-id][data-widget-param-name]';

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
      if (!setWidgetParamValue(wid, paramName, evt.target.value)) return;
      if (shouldRefreshOnWidgetParamChange(paramName)) refreshCharts();
      persist();
    });

    input.addEventListener('change', (evt) => {
      const wid = evt.target.dataset[WIDGET_PARAM_DATASET.WIDGET_ID];
      const paramName = evt.target.dataset[WIDGET_PARAM_DATASET.PARAM_NAME];
      if (!setWidgetParamValue(wid, paramName, evt.target.value)) return;
      if (shouldRefreshOnWidgetParamChange(paramName)) refreshCharts();
      persist();
    });

    input.addEventListener('click', (evt) => {
      if (!evt.ctrlKey) return;

      const sourceWidgetId = evt.target.dataset[WIDGET_PARAM_DATASET.WIDGET_ID];
      const paramName = evt.target.dataset[WIDGET_PARAM_DATASET.PARAM_NAME];
      const rawValue = evt.target.value;
      if (!sourceWidgetId || !paramName) return;

      let hasAnyUpdates = false;
      for (const widget of tab.widgets) {
        if (widget.id === sourceWidgetId) continue;
        hasAnyUpdates = setWidgetParamValue(widget.id, paramName, rawValue) || hasAnyUpdates;
      }
      if (!hasAnyUpdates) return;

      root.querySelectorAll(`${widgetParamSelector}[data-widget-param-name="${paramName}"]`).forEach((otherInput) => {
        otherInput.value = rawValue;
      });

      if (shouldRefreshOnWidgetParamChange(paramName)) refreshCharts();
      persist();
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
          refreshCharts();
          persist();
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
      refreshCharts();
      persist();
      return;
    }

    const hideCurrentWidgetId = evt.target?.dataset?.widgetHistoryHideCurrentWidgetId;
    if (hideCurrentWidgetId) {
      const target = tab.widgets.find((w) => w.id === hideCurrentWidgetId);
      if (!target) return;
      target.config ||= {};
      target.config.hideCurrentSnapshotSeries = Boolean(evt.target.checked);
      refreshCharts();
      persist();
      return;
    }

    const widgetId = evt.target?.dataset?.widgetHistoryOptionWidgetId;
    if (!widgetId) return;
    if (!applyHistorySelection(widgetId, evt.target)) return;
    updateWidgetHistoryControls(root, tab);
    refreshCharts();
    persist();
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
    persist();
  });

  updateWidgetHistoryControls(root, tab);
  refreshCharts();
}

async function refreshCharts() {
  const tab = activeTab();
  if (!tab) return;

  const history = state.historyByTab[tab.id] || [];
  const latest = history[history.length - 1] || null;
  const publishChartRuntime = (entry, title = '') => {
    publishMcpWidgetRuntimeData(tab.id, entry.widget.id, createChartRuntimeData({
      widget: entry.widget,
      definition: entry.definition,
      labels: entry.chart?.data?.labels || [],
      datasets: entry.chart?.data?.datasets || [],
      title,
      historyLength: history.length,
      sourceSnapshotTime: latest?.time || null
    }));
  };

  const entries = Array.from(chartInstances.values());
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
            pointHitRadius: 14,
            pointHoverRadius: 4,
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
            pointHitRadius: 14,
            pointHoverRadius: 4,
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
              pointHitRadius: 14,
              pointHoverRadius: 4,
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
              pointHitRadius: 14,
              pointHoverRadius: 4,
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

      chart.options.plugins.legend.labels.generateLabels = (legendChart) => {
        const defaultGenerator = Chart.defaults.plugins.legend.labels.generateLabels;
        return defaultGenerator(legendChart)
          .filter((item) => !legendChart.data.datasets[item.datasetIndex]?.hiddenInLegend);
      };
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
      chart.update();
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
        pointHitRadius: dataset?.pointHitRadius ?? 14,
        pointHoverRadius: dataset?.pointHoverRadius ?? 4,
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
      chart.update();
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
      chart.update();
      publishChartRuntime(entry);
      continue;
    }

    chart.data.labels = history.map((x) => new Date(x.time).toLocaleTimeString());
    chart.data.datasets[0].data = history.map((x) => x[metric]);
    chart.options.plugins.legend.display = false;
    chart.update();
    publishChartRuntime(entry);
  }

  await Promise.all(producerRenderTasks);

  const consumerRenderTasks = [];
  for (const entry of entries) {
    const { mode, definition } = entry;
    if (mode === 'table' && typeof definition.render === 'function' && definition.consumesWidgetData) {
      consumerRenderTasks.push(renderTableWidgetEntry(entry, latest, history));
    }
  }
  await Promise.all(consumerRenderTasks);
}

async function renderTableWidgetEntry(entry, latest, history) {
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
      persist();
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
}

async function refreshSingleTableWidget(widgetId) {
  const tab = activeTab();
  if (!tab || !widgetId) return;

  const entry = chartInstances.get(widgetId);
  if (!entry || entry.mode !== 'table') return;

  const history = state.historyByTab[tab.id] || [];
  const latest = history[history.length - 1] || null;
  await renderTableWidgetEntry(entry, latest, history);
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
  persist();
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

  const tasks = [];
  for (const widget of tab.widgets || []) {
    if (widget.type === 'vol-upfront') tasks.push(refreshSingleTableWidget(widget.id));
  }
  await Promise.all(tasks);
}

function tickTabIfActive(tabId) {
  if (state.activeTabId !== tabId) return;
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
  persist();
}

async function tickTab(tabId) {
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
    const point = await provider.fetchSnapshot(tab.providerConfig, skewMetrics);
    if (shouldSaveRawSnapshots(tab)) {
      try {
        await window.appBridge.saveRawSnapshot?.({
          tab: {
            id: tab.id,
            title: tab.title,
            providerKey: tab.providerKey,
            providerConfig: tab.providerConfig
          },
          snapshot: point
        });
      } catch (err) {
        console.warn('Failed to save raw snapshot', err);
      }
    }

    ensureTabHistoryPolicy(tab);
    if (!tabSupportsHistorySnapshots(tab)) {
      tickTabIfActive(tabId);
      setTabStatus(tabId, `ok • ${tab.title} • history disabled (no history-input chart)`);
      persist();
      return;
    }

    const storedPoint = shouldCompactHistorySnapshots(tab)
      ? trimSnapshotForWidgets(point, tab)
      : point;
    state.historyByTab[tab.id].push(storedPoint);

    const keep = Math.max(20, Number(tab.providerConfig.keepPoints) || 200);
    while (state.historyByTab[tab.id].length > keep) {
      state.historyByTab[tab.id].shift();
    }

    tickTabIfActive(tabId);
    if (point.theBlock?.latestDate) {
      const chartCount = Object.keys(point.theBlock?.charts || {}).length;
      setTabStatus(tabId, `ok • ${tab.title} • The Block charts=${chartCount} • latest=${point.theBlock.latestDate}`);
    } else {
      setTabStatus(
        tabId,
        `ok • ${tab.title} • px=${point.px?.toFixed(3) ?? 'n/a'} • lower=${point.lower ?? 'n/a'} upper=${point.upper ?? 'n/a'}`
      );
    }
    persist();
  } catch (err) {
    setTabStatus(tabId, `error • ${tab.title}: ${err?.message || err}`);
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

function start() {
  const tab = activeTab();
  if (!tab) return;
  startTabPolling(tab.id);
  updatePollingControlsForActiveTab();
}

function stop() {
  const tab = activeTab();
  if (!tab) return;
  stopTabPolling(tab.id);
  setTabStatus(tab.id, 'stopped');
  updatePollingControlsForActiveTab();
}

async function refreshActiveTabOnce() {
  const tab = activeTab();
  if (!tab || tabRefreshInFlight.has(tab.id)) return;

  tabRefreshInFlight.add(tab.id);
  updatePollingControlsForActiveTab();
  try {
    await tickTab(tab.id);
  } finally {
    tabRefreshInFlight.delete(tab.id);
    updatePollingControlsForActiveTab();
  }
}

function clearActiveTabSnapshot() {
  const tab = activeTab();
  if (!tab) return;

  state.historyByTab[tab.id] = [];
  refreshCharts();
  setTabStatus(tab.id, `snapshot cleared • ${tab.title}`);
  persist();
}

function bindEvents() {
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
      persist();
      if (tabTimers.has(tab.id)) startTabPolling(tab.id);
    });
  });
}

async function init() {
  bindMcpRuntimeBridge();
  populateWidgetTypeSelect();
  bindEvents();
  const loaded = await window.appBridge.loadState();
  state.tabs = loaded.tabs || [];
  state.activeTabId = loaded.activeTabId || state.tabs[0]?.id;
  state.historyByTab = loaded.historyByTab && typeof loaded.historyByTab === 'object'
    ? loaded.historyByTab
    : {};

  if (!state.tabs.length) addTab();

  let compactedLoadedHistory = false;
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
    compactedLoadedHistory = compactedLoadedHistory || Boolean(state.historyByTab[tab.id]?.length);
  }

  if (!state.activeTabId) state.activeTabId = state.tabs[0].id;

  applyTabToForm(activeTab());
  renderTabs();
  renderWidgets();
  updatePollingControlsForActiveTab();
  setTabStatus(state.activeTabId, 'ready');
  if (compactedLoadedHistory) persist();
}

init();
