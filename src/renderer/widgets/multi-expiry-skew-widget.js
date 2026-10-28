import { ensureUPlotRuntime } from './widget-renderers.js';
import { normalizeSkewDelta } from '../../shared/zero-dte-skew-calculations.mjs';
import { buildMultiExpirySeries, mergeSkewPoints, normalizeSkewExpirations, normalizeSkewSmoothing, skewIdentity, skewDisplayRange } from '../../shared/multi-expiry-skew.mjs';
import { skewHistorySession } from '../skew-history.js';

const states = new WeakMap();
const colors = ['#a78bfa', '#38bdf8', '#fb923c', '#34d399', '#fb7185', '#facc15'];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dateInput = (v) => /^\d{8}$/.test(v || '') ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6)}` : v || '';

export function multiExpiryVisibilityOptions(lines, config, change, current = () => true) {
  let pending = false;
  return {
    series: [{}, ...lines.map((line, i) => ({ label: line.expiration, stroke: colors[i % colors.length], width: 1.5,
      show: !config.hiddenExpirations.includes(line.expiration),
      spanGaps: true, points: { show: line.data.filter(Number.isFinite).length === 1, size: 4 } }))],
    hooks: { setSeries: [(plot, _index, options) => {
      if (typeof options.show !== 'boolean' || pending || !current()) return;
      pending = true;
      // Legend isolation may toggle several lines in one event; persist the final state once.
      queueMicrotask(() => {
        pending = false;
        if (!current()) return;
        const hidden = new Set(config.hiddenExpirations);
        lines.forEach((line, i) => {
          if (plot.series[i + 1].show === false) hidden.add(line.expiration);
          else hidden.delete(line.expiration);
        });
        if (hidden.size === config.hiddenExpirations.length && config.hiddenExpirations.every((expiry) => hidden.has(expiry))) return;
        config.hiddenExpirations = [...hidden];
        change();
      });
    }] }
  };
}

function controls(config) {
  return `<div class="straddle-controls">
    <label>D <input data-skew-setting="targetDelta" type="number" min="0.01" max="0.49" step="0.01" value="${config.targetDelta}" /></label>
    <label>Smoothing <select data-skew-setting="smoothing">${[
      ['linear', 'Linear'], ['ma5', 'Moving average 5 points'], ['ma15', 'Moving average 15 points']
    ].map(([value, label]) => `<option value="${value}"${config.smoothing === value ? ' selected' : ''}>${label}</option>`).join('')}</select></label>
    </div><details data-skew-expirations${config.expirationsExpanded !== false ? ' open' : ''}><summary>Settings</summary>
    <div class="straddle-controls">
    <label>From <input data-skew-setting="startDate" type="date" value="${esc(config.startDate)}" />
      <input data-skew-setting="startTime" type="time" step="1" aria-label="From time (local)" title="Local chart time; requires From date" value="${esc(config.startTime)}" /></label>
    <label>To <input data-skew-setting="endDate" type="date" value="${esc(config.endDate)}" />
      <input data-skew-setting="endTime" type="time" step="1" aria-label="To time (local)" title="Local chart time; requires To date" value="${esc(config.endTime)}" /></label>
    </div><div class="multi-skew-expirations">
    ${config.expirations.map((expiry, i) => `<div class="multi-skew-expiry"><label>Exp <input data-skew-expiry="${i}" type="date" value="${esc(dateInput(expiry))}" /></label><button type="button" class="btn btn-compact" data-skew-remove="${i}" aria-label="Remove expiration">×</button></div>`).join('')}
    <button type="button" class="btn btn-compact" data-skew-add>Add expiration</button></div></details>`;
}

export function destroyMultiExpirySkewWidget(container) {
  const previous = states.get(container);
  previous?.observer?.disconnect();
  previous?.chart?.destroy();
  states.delete(container);
}

export const multiExpirySkewWidget = {
  type: 'multi-expiry-skew', defaultTitle: 'Skew. Multi-Expiry', mode: 'table', gridSpan: 3, heightUnits: 2, requiresHistory: true,
  defaultConfig: { targetDelta: 0.25, expirations: [], hiddenExpirations: [], expirationsExpanded: true, startDate: '', endDate: '', startTime: '', endTime: '', smoothing: 'linear' },
  destroy: destroyMultiExpirySkewWidget,
  async render({ container, source, snapshot, history, widget, widgetData, onConfigChange, isCurrent = () => true }) {
    destroyMultiExpirySkewWidget(container);
    const state = {};
    states.set(container, state);
    const current = () => states.get(container) === state && isCurrent();
    const config = { ...multiExpirySkewWidget.defaultConfig, ...widget.config };
    config.expirations = Array.isArray(config.expirations) ? [...config.expirations] : [];
    config.hiddenExpirations = normalizeSkewExpirations(config.hiddenExpirations);
    config.targetDelta = normalizeSkewDelta(config.targetDelta);
    config.smoothing = normalizeSkewSmoothing(config.smoothing);
    container.innerHTML = `${controls(config)}<div data-skew-status class="multi-skew-status">Loading history…</div><div data-skew-chart class="multi-skew-chart"></div>`;
    const change = () => { widget.config = { ...config }; onConfigChange?.(); };
    const expirationDetails = container.querySelector('[data-skew-expirations]');
    expirationDetails.addEventListener('toggle', () => {
      if (!current() || expirationDetails.open === (config.expirationsExpanded !== false)) return;
      config.expirationsExpanded = expirationDetails.open;
      change();
    });
    container.querySelectorAll('[data-skew-setting]').forEach((input) => input.addEventListener('change', () => {
      const key = input.dataset.skewSetting;
      config[key] = key === 'targetDelta' ? normalizeSkewDelta(input.value) : input.value;
      change();
    }));
    container.querySelectorAll('[data-skew-expiry]').forEach((input) => input.addEventListener('change', () => {
      config.expirations[Number(input.dataset.skewExpiry)] = input.value.replaceAll('-', '');
      change();
    }));
    container.querySelectorAll('[data-skew-remove]').forEach((button) => button.addEventListener('click', () => {
      config.expirations.splice(Number(button.dataset.skewRemove), 1); change();
    }));
    container.querySelector('[data-skew-add]').addEventListener('click', () => { config.expirations.push(''); change(); });
    const status = container.querySelector('[data-skew-status]');
    const expirations = normalizeSkewExpirations(config.expirations);
    if (!source || !expirations.length) { status.textContent = 'Add fixed expiration dates to start recording Skew.'; return; }
    const range = skewDisplayRange(config);
    if (range.start > range.end) {
      status.textContent = 'From must be on or before To.'; return;
    }
    try {
      await skewHistorySession.capture(source, [{ ...widget, config }], [...(history || []), ...(snapshot ? [snapshot] : [])]);
      if (!current()) return;
      const warnings = [];
      const lines = await Promise.all(expirations.map(async (expiration) => {
        const identity = skewIdentity(source, expiration, config.targetDelta);
        let archived = [];
        try {
          if (!window.appBridge?.loadSkewHistory) throw new Error('Skew history loader is unavailable');
          const result = await window.appBridge.loadSkewHistory({ identity, ...range.archive });
          if (result?.ok !== true) throw new Error(result?.error || 'Skew history load failed');
          archived = (result.documents || []).flatMap((document) => document.points);
          warnings.push(...(result.warnings || []).map((w) => w.message));
        } catch (err) { warnings.push(err.message); }
        const saveError = skewHistorySession.error(identity);
        if (saveError) warnings.push(`Save failed (will retry): ${saveError}`);
        const points = mergeSkewPoints(archived, skewHistorySession.points(identity));
        if (points.at(-1)?.warning) warnings.push(`${expiration}: ${points.at(-1).warning}`);
        return { expiration, points };
      }));
      if (!current()) return;
      const series = buildMultiExpirySeries(lines, config);
      const pointCount = series.lines.reduce((n, l) => n + l.data.filter(Number.isFinite).length, 0);
      status.textContent = `${pointCount} points${warnings.length ? ` · ${[...new Set(warnings)].join(' | ')}` : ''}`;
      widgetData?.publish?.({ type: 'multi-expiry-skew', status: warnings.length ? 'warning' : 'ok', config, series, warnings });
      if (!pointCount) return;
      const UPlot = await ensureUPlotRuntime();
      if (!current()) return;
      const host = container.querySelector('[data-skew-chart]');
      const chartSize = () => ({ width: Math.max(180, host.clientWidth),
        height: Math.max(80, host.clientHeight - (state.chart?.root.querySelector('.u-legend')?.getBoundingClientRect().height ?? 24)) });
      const options = {
        ...chartSize(),
        cursor: { drag: { x: false, y: false } }, legend: { show: true },
        // Ordinal spacing compresses time gaps while labels/hover keep the actual timestamps.
        scales: { x: { time: true, distr: 2 }, y: { range: (_u, min, max) => {
          const pad = Math.max((max - min) * 0.1, 0.1);
          return [min - pad, max + pad];
        } } },
        axes: [{ stroke: '#a1a1aa', grid: { show: false } }, { stroke: '#a1a1aa', size: 55, label: 'Skew (vol pts)',
          values: (_u, ticks) => ticks.map((v) => `${v.toFixed(2)}`), grid: { stroke: '#ffffff18' } }],
        ...multiExpiryVisibilityOptions(series.lines, config, change, current)
      };
      state.chart = new UPlot(options, [series.x, ...series.lines.map((line) => line.data)], host);
      state.chart.setSize(chartSize());
      if (typeof ResizeObserver !== 'undefined') {
        state.observer = new ResizeObserver(() => { if (current()) state.chart.setSize(chartSize()); });
        state.observer.observe(host);
      }
    } catch (err) { if (current()) status.textContent = `Skew: ${err.message}`; }
  }
};
