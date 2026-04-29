import { TradingViewProvider } from '../shared/tradingview-provider.js';
import { getWidgetDefinition, widgetDefinitions } from './widgets/index.js';
import { createWidgetCard, createWidgetChart } from './widgets/widget-renderers.js';
import { skewMetrics } from './widgets/metrics.js';
import {
  normalizeWidgetParamValue,
  shouldRefreshOnWidgetParamChange,
  WIDGET_PARAM_DATASET
} from './widgets/widget-params.js';

const providers = {
  tradingview: new TradingViewProvider()
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
let tabContextTargetId = null;
let renameTargetTabId = null;
let draggedTabId = null;
let historySidecarWidgetId = null;

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
  $('startBtn').disabled = running || refreshing;
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
  return tab.widgets.some((widget) => String(widget?.type || '').startsWith('ndate-skew-'));
}

function ensureTabHistoryPolicy(tab) {
  if (!tab?.id) return;
  if (!tabSupportsHistorySnapshots(tab)) {
    state.historyByTab[tab.id] = [];
    return;
  }
  if (!Array.isArray(state.historyByTab[tab.id])) state.historyByTab[tab.id] = [];
}

function applyTabToForm(tab) {
  $('providerKey').value = tab.providerKey;
  $('apiBase').value = tab.providerConfig.apiBase || '';
  $('ticker').value = tab.providerConfig.ticker || '';
  $('root').value = tab.providerConfig.root || '';
  $('expiryStart').value = tab.providerConfig.expiryStart || tab.providerConfig.expiry || defaultExpiry();
  $('expiryEnd').value = tab.providerConfig.expiryEnd || '';
  $('yahooSymbol').value = tab.providerConfig.yahooSymbol || '';
  $('pollSec').value = String(tab.providerConfig.pollSec ?? 5);
  $('keepPoints').value = String(tab.providerConfig.keepPoints ?? 200);
}

function readFormToTab(tab) {
  tab.providerKey = $('providerKey').value;
  tab.providerConfig = {
    apiBase: $('apiBase').value.trim(),
    ticker: $('ticker').value.trim(),
    root: $('root').value.trim(),
    expiryStart: $('expiryStart').value.trim(),
    expiryEnd: $('expiryEnd').value.trim(),
    yahooSymbol: $('yahooSymbol').value.trim(),
    pollSec: Number($('pollSec').value) || 5,
    keepPoints: Number($('keepPoints').value) || 200
  };
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
  for (const { chart } of chartInstances.values()) {
    if (chart && typeof chart.destroy === 'function') chart.destroy();
  }
  chartInstances.clear();
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
  const selectedSet = new Set(getSelectedHistorySnapshotTimes(widget));
  if (!selectedSet.size || !Array.isArray(history) || history.length < 2) return [];

  const latest = history[history.length - 1];
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
  const selectedTimes = new Set(getSelectedHistorySnapshotTimes(widget).filter((time) => time !== latestTime));
  const optionsHtml = [];
  for (let idx = history.length - 2; idx >= 0; idx -= 1) {
    const snapshot = history[idx];
    const time = String(snapshot?.time || '');
    if (!time) continue;
    const idxFromEnd = history.length - 1 - idx;
    const selected = selectedTimes.has(time) ? ' checked' : '';
    const optionId = historyOptionId(widget.id, time, idxFromEnd);
    optionsHtml.push(`
      <label class="widget-history-option" for="${optionId}">
        <input id="${optionId}" type="checkbox" value="${time}"${selected} data-widget-history-option-widget-id="${widget.id}" />
        <span>${formatSnapshotOptionLabel(snapshot, idxFromEnd)}</span>
      </label>
    `);
  }

  sidecarTitle.textContent = `history • ${widget.title || widget.type}`;
  sidecarBody.innerHTML = optionsHtml.length
    ? optionsHtml.join('')
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

    const ctx = document.getElementById(`canvas-${widget.id}`)?.getContext('2d');
    if (!ctx) continue;

    const chart = createWidgetChart(ctx, definition, {
      onLegendVisibilityChange: () => {
        if ((definition.mode || 'timeseries') !== 'snapshot-series') return;
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
      if (!isInteractiveWidgetControl(evt.target)) return;
      setDragEnabled(false);
    });

    card.addEventListener('pointerup', () => {
      const activeInsideCard = card.contains(document.activeElement);
      if (!activeInsideCard) setDragEnabled(true);
    });

    card.addEventListener('dragstart', (evt) => {
      if (isInteractiveWidgetControl(evt.target)) {
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

  const applyHistorySelection = (widgetId) => {
    const target = tab.widgets.find((w) => w.id === widgetId);
    if (!target) return false;
    target.config ||= {};
    const checked = Array.from(root.querySelectorAll(`input[data-widget-history-option-widget-id="${widgetId}"]:checked`))
      .map((node) => node.value);
    target.config.historySnapshotTimes = checked;
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
    const widgetId = evt.target?.dataset?.widgetHistoryOptionWidgetId;
    if (!widgetId) return;
    if (!applyHistorySelection(widgetId)) return;
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

function refreshCharts() {
  const tab = activeTab();
  if (!tab) return;

  const history = state.historyByTab[tab.id] || [];
  const latest = history[history.length - 1] || null;

  for (const entry of chartInstances.values()) {
    const { chart, mode, metric, definition, widget } = entry;
    if (mode === 'table' && typeof definition.render === 'function') {
      const target = document.getElementById(`widget-body-${widget.id}`);
      if (!target) continue;
      definition.render({
        container: target,
        snapshot: latest,
        widget,
        onConfigChange: () => {
          persist();
          refreshCharts();
        }
      });
      continue;
    }

    if (mode === 'snapshot-series' && typeof definition.buildSnapshotSeries === 'function') {
      const widgetSnapshot = latest;
      const series = definition.buildSnapshotSeries(widgetSnapshot, widget);
      chart.data.labels = series?.labels || [];

      if (Array.isArray(series?.datasets) && series.datasets.length) {
        chart.data.datasets = series.datasets.map((dataset, idx) => ({
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
          data: series?.values || [],
          borderWidth: 1,
          tension: 0.2,
          pointRadius: 0,
          pointHitRadius: 14,
          pointHoverRadius: 4,
          borderColor: definition.color || '#7aa2ff'
        }];
      }

      const hasMultipleBaseDatasets = chart.data.datasets.length > 1;
      const historicalComparisons = collectHistoricalComparisons(history, widget);
      const hasSingleSelectedSnapshot = historicalComparisons.length === 1;
      const historyDatasets = [];
      const baseDatasetsCount = chart.data.datasets.length;

      for (const comparison of historicalComparisons) {
        const historicalSeries = definition.buildSnapshotSeries(comparison.snapshot, widget);
        if (!Array.isArray(historicalSeries?.labels) || !Array.isArray(historicalSeries?.datasets)) {
          const baseDataset = chart.data.datasets[0];
          if (!baseDataset) continue;
          const byLabel = Object.fromEntries((historicalSeries?.labels || []).map((label, i) => [String(label), historicalSeries.values?.[i] ?? null]));
          historyDatasets.push({
            label: `${baseDataset.label} • ${comparison.label}`,
            data: (chart.data.labels || []).map((label) => (String(label) in byLabel ? byLabel[String(label)] : null)),
            borderWidth: 1,
            tension: 0.2,
            pointRadius: 0,
            pointHitRadius: 14,
            pointHoverRadius: 4,
            borderColor: baseDataset.borderColor || definition.color || '#7aa2ff',
            borderDash: [6, 4],
            hiddenInLegend: hasSingleSelectedSnapshot,
            pointMeta: [],
            tooltipFormatter: typeof baseDataset?.tooltipFormatter === 'function' ? baseDataset.tooltipFormatter : null
          });
          continue;
        }

        for (let idx = 0; idx < chart.data.datasets.length; idx += 1) {
          const baseDataset = chart.data.datasets[idx];
          const seriesToUse = historicalSeries.datasets[idx] || historicalSeries.datasets.find((x) => x?.label === baseDataset.label);
          if (!seriesToUse) continue;
          const byLabel = Object.fromEntries((historicalSeries.labels || []).map((label, i) => [String(label), seriesToUse.data?.[i] ?? null]));
          const metaByLabel = Object.fromEntries((historicalSeries.labels || []).map((label, i) => [String(label), seriesToUse.pointMeta?.[i] ?? null]));
          historyDatasets.push({
            label: `${baseDataset.label} • ${comparison.label}`,
            data: (chart.data.labels || []).map((label) => (String(label) in byLabel ? byLabel[String(label)] : null)),
            borderWidth: 1,
            tension: 0.2,
            pointRadius: 0,
            pointHitRadius: 14,
            pointHoverRadius: 4,
            borderColor: baseDataset.borderColor || definition.color || '#7aa2ff',
            borderDash: [6, 4],
            hiddenInLegend: hasSingleSelectedSnapshot,
            baseDatasetIndex: idx,
            pointMeta: (chart.data.labels || []).map((label) => (String(label) in metaByLabel ? metaByLabel[String(label)] : null)),
            tooltipFormatter: typeof baseDataset?.tooltipFormatter === 'function' ? baseDataset.tooltipFormatter : null
          });
        }
      }

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
      chart.options.plugins.legend.display = hasMultipleBaseDatasets || (!hasSingleSelectedSnapshot && historyDatasets.length > 0);
      applyHiddenSnapshotSeriesLabels(widget, chart);
      syncLinkedHistoryVisibility(chart);
      chart.update();
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
      continue;
    }

    chart.data.labels = history.map((x) => new Date(x.time).toLocaleTimeString());
    chart.data.datasets[0].data = history.map((x) => x[metric]);
    chart.options.plugins.legend.display = false;
    chart.update();
  }
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
      keepPoints: 200
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

    ensureTabHistoryPolicy(tab);
    if (!tabSupportsHistorySnapshots(tab)) {
      tickTabIfActive(tabId);
      setTabStatus(tabId, `ok • ${tab.title} • history disabled (no history-input chart)`);
      persist();
      return;
    }

    state.historyByTab[tab.id].push(point);

    const keep = Math.max(20, Number(tab.providerConfig.keepPoints) || 200);
    while (state.historyByTab[tab.id].length > keep) {
      state.historyByTab[tab.id].shift();
    }

    tickTabIfActive(tabId);
    setTabStatus(
      tabId,
      `ok • ${tab.title} • px=${point.px?.toFixed(3) ?? 'n/a'} • lower=${point.lower ?? 'n/a'} upper=${point.upper ?? 'n/a'}`
    );
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

  ['providerKey', 'apiBase', 'ticker', 'root', 'expiryStart', 'expiryEnd', 'yahooSymbol', 'pollSec', 'keepPoints'].forEach((id) => {
    $(id).addEventListener('change', () => {
      const tab = activeTab();
      if (!tab) return;
      readFormToTab(tab);
      persist();
      if (tabTimers.has(tab.id)) startTabPolling(tab.id);
    });
  });
}

async function init() {
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
  }

  if (!state.activeTabId) state.activeTabId = state.tabs[0].id;

  applyTabToForm(activeTab());
  renderTabs();
  renderWidgets();
  updatePollingControlsForActiveTab();
  setTabStatus(state.activeTabId, 'ready');
}

init();
