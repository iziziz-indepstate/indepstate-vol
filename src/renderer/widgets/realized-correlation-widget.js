import { calculateRealizedCorrelationSeries, resolveEwmaConfig } from '../../shared/realized-correlation-calculations.mjs';
import { ensureChartJsRuntime } from './widget-renderers.js';

const states = new WeakMap();
const forceRefresh = new WeakSet();
const SERIES = [['rc5', 'RC5', '#38bdf8'], ['rc10', 'RC10', '#f59e0b'], ['rc21', 'RC21', '#22c55e'], ['cor1m', 'COR1M', '#a78bfa']];
const escape = (value) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const format = (value) => Number.isFinite(value) ? value.toFixed(2) : 'n/a';
const sourceMeta = (source) => source ? {
  provider: source.provider, cached: Boolean(source.cached), updatedAt: source.updatedAt || null, warning: source.warning || null
} : null;

function series(config) {
  return [...SERIES.slice(0, 3), ['rcEwma', `RC EWMA · H=${config.ewmaHalfLife}`, '#fb7185', 'ewma'], SERIES[3]];
}

function controls(config) {
  return `<div class="ivrv-controls">
    <label>Start date<input type="date" data-rc-config="startDate" value="${escape(config.startDate)}"></label>
    <label>End date<input type="date" data-rc-config="endDate" value="${escape(config.endDate)}"></label>
    <label>EWMA half-life (sessions)<input type="number" min="1" max="63" step="1" data-rc-config="ewmaHalfLife" value="${escape(config.ewmaHalfLife)}"></label>
    ${[...series(config).map(([key, label, , visibilityKey = key]) => [visibilityKey, label]), ['spread', 'Spread'], ['cache', 'Cache']].map(([key, label]) => `
      <label class="ivrv-cache-check"><input type="checkbox" data-rc-config="${key}"${config[key] !== false ? ' checked' : ''}>${label}</label>`).join('')}
    <button type="button" class="btn" data-rc-load>Load data</button>
  </div>`;
}

function bind(container, widget, onConfigChange) {
  container.querySelectorAll('[data-rc-config]').forEach((control) => control.addEventListener('change', () => {
    const key = control.dataset.rcConfig;
    let value = control.type === 'checkbox' ? control.checked : control.value;
    if (key === 'ewmaHalfLife') {
      try {
        value = resolveEwmaConfig(value).halfLife;
        control.setCustomValidity?.('');
      } catch (error) {
        control.setCustomValidity?.(error.message);
        control.reportValidity?.();
        return;
      }
    }
    widget.config[key] = value;
    onConfigChange();
  }));
  container.querySelector('[data-rc-load]')?.addEventListener('click', () => {
    forceRefresh.add(widget);
    onConfigChange();
  });
}

function destroyCharts(state) {
  state?.charts.forEach((chart) => chart.destroy());
  if (state) state.charts = [];
}

function dataset(label, values, color) {
  return { label, data: values, borderColor: color, borderWidth: 1.5, pointRadius: 0, pointHitRadius: 8, tension: 0, spanGaps: false };
}

export const realizedCorrelationWidget = {
  type: 'realized-correlation',
  defaultTitle: 'COR. Realized Correlation',
  mode: 'table',
  gridSpan: 6,
  refreshOnDashboardRefresh: false,
  defaultConfig: { startDate: '', endDate: '', rc5: true, rc10: true, rc21: true, ewma: true, ewmaHalfLife: 10, cor1m: true, spread: true, cache: true },
  destroy(container) {
    const state = states.get(container);
    if (state) state.version += 1;
    destroyCharts(state);
    states.delete(container);
  },
  async render({ container, widget, widgetData, onConfigChange }) {
    let state = states.get(container);
    if (!state) { state = { version: 0, charts: [], inputs: null, key: null }; states.set(container, state); }
    const version = ++state.version;
    const current = () => states.get(container) === state && state.version === version;
    destroyCharts(state);
    widget.config ||= {};
    const config = { ...realizedCorrelationWidget.defaultConfig, ...widget.config };
    // Recover malformed persisted configuration; interactive edits are validated at the control.
    try { config.ewmaHalfLife = resolveEwmaConfig(config.ewmaHalfLife).halfLife; }
    catch (_) { config.ewmaHalfLife = 10; widget.config.ewmaHalfLife = 10; }
    const publish = (payload) => widgetData?.publish?.({ type: realizedCorrelationWidget.type,
      title: widget.title || realizedCorrelationWidget.defaultTitle, config: { ...config }, ...payload });
    const forced = forceRefresh.has(widget);
    forceRefresh.delete(widget);
    container.innerHTML = `${controls(config)}<div class="ivrv-status" role="status">Loading Top 50 holdings and daily prices…</div>`;
    bind(container, widget, onConfigChange);
    try {
      const request = { startDate: config.startDate, endDate: config.endDate, cache: config.cache !== false, ewmaHalfLife: config.ewmaHalfLife };
      const key = JSON.stringify(request);
      let inputs = !forced && state.key === key ? state.inputs : null;
      if (!inputs) {
        state.inputs = null;
        state.key = null;
        inputs = await window.appBridge.getRealizedCorrelationInputs({ ...request, forceRefresh: forced });
      }
      if (!current()) return;
      state.inputs = inputs;
      state.key = key;
      const result = calculateRealizedCorrelationSeries({ basket: inputs.holdings.basket, calendarRows: inputs.calendar.bars,
        prices: Object.fromEntries(Object.entries(inputs.prices).map(([symbol, source]) => [symbol, source.bars])),
        cor1mRows: inputs.cor1m?.bars || [], startDate: inputs.startDate, endDate: inputs.endDate, ewmaHalfLife: config.ewmaHalfLife });
      const warnings = [...new Set([...inputs.warnings, ...result.warnings])];
      const lastCorDate = inputs.cor1m?.bars.at(-1)?.date || null;
      if (lastCorDate && lastCorDate < result.latest.date) warnings.push(`COR1M ends on ${lastCorDate}; newer spread values are unavailable.`);
      const partial = !inputs.cor1m || result.latest.rc21 === null || result.latest.cor1m === null || result.latest.rcEwma === null;
      const sources = { holdings: sourceMeta(inputs.holdings), calendar: sourceMeta(inputs.calendar),
        prices: Object.fromEntries(Object.entries(inputs.prices).map(([symbol, source]) => [symbol, sourceMeta(source)])),
        cor1m: sourceMeta(inputs.cor1m) };
      const payload = { status: partial ? 'partial' : 'ok', basket: inputs.holdings.basket, basketAsOf: inputs.holdings.asOf,
        basketMode: 'current-fixed-weights', priceMode: 'adjusted', startDate: inputs.startDate, endDate: inputs.endDate,
        sources, ...result, latestCor1mDate: lastCorDate, warnings };
      container.innerHTML = `${controls(config)}<div class="rc-widget">
        <div class="ivrv-summary rc-summary">${[...series(config).map(([key, label]) => [label, result.latest[key]]), ['COR1M − RC21', result.latest.spread]]
          .map(([label, value]) => `<div><span>${label}</span><strong>${format(value)}</strong></div>`).join('')}</div>
        <div class="ivrv-freshness">Period: ${escape(inputs.startDate)} – ${escape(inputs.endDate)} · Latest session: ${escape(result.latest.date)} · COR1M: ${escape(lastCorDate || 'unavailable')} · Weights: ${escape(inputs.holdings.asOf)}</div>
        <div class="ivrv-source-meta"><span>Holdings: iShares IVV${inputs.holdings.cached ? ' (cache)' : ''}</span>
          <span>Adjusted prices: Yahoo (${Object.values(inputs.prices).filter((source) => source.cached).length}/50 cached)</span>
          <span>COR1M: ${inputs.cor1m ? `Cboe${inputs.cor1m.cached ? ' (cache)' : ''}` : 'unavailable'}</span>
          <span>Holdings fetched: ${escape(inputs.holdings.updatedAt)}</span>
          <span>Oldest price fetch: ${escape(Object.values(inputs.prices).map((source) => source.updatedAt).filter(Boolean).sort()[0] || 'n/a')}</span>
          <span>COR1M fetched: ${escape(inputs.cor1m?.updatedAt || 'n/a')}</span></div>
        <div class="ivrv-freshness">Approximation: current Top 50 IVV constituents and fixed weights applied to all dates. Not a historical reconstruction of Cboe COR1M. Spread compares implied expectations with trailing realization.</div>
        ${warnings.map((warning) => `<div class="ivrv-warning">${escape(warning)}</div>`).join('')}
        <div class="ivrv-charts rc-charts"><div><h4>Realized and implied correlation · points</h4><canvas data-rc-chart></canvas></div>
          ${config.spread !== false ? '<div><h4>COR1M − RC21 · points</h4><canvas data-rc-spread></canvas></div>' : ''}</div>
        <details class="rc-basket"><summary>Basket · 50 equities · weights as of ${escape(inputs.holdings.asOf)}</summary>
          <table><thead><tr><th>Symbol</th><th>Name</th><th>Basket weight</th></tr></thead><tbody>
          ${inputs.holdings.basket.map((row) => `<tr><td>${escape(row.symbol)}</td><td>${escape(row.name)}</td><td>${(row.weight * 100).toFixed(3)}%</td></tr>`).join('')}</tbody></table></details>
      </div>`;
      bind(container, widget, onConfigChange);
      const ChartRuntime = await ensureChartJsRuntime();
      if (!current()) return;
      const labels = result.series.map((row) => row.date);
      const options = () => ({ responsive: true, maintainAspectRatio: false, animation: false,
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { labels: { color: '#eaeaf0', boxWidth: 10 } },
          tooltip: { callbacks: { label: (context) => `${context.dataset.label}: ${format(context.parsed.y)}` } } },
        scales: { x: { ticks: { color: '#aaaab5', maxTicksLimit: 8 } }, y: { ticks: { color: '#aaaab5' } } } });
      const mainOptions = options();
      mainOptions.plugins.legend.onClick = (_event, item, legend) => {
        if (!current()) return;
        const descriptor = series(config)[item.datasetIndex];
        if (!descriptor) return;
        const key = descriptor[3] || descriptor[0];
        const visible = !legend.chart.isDatasetVisible(item.datasetIndex);
        legend.chart.setDatasetVisibility(item.datasetIndex, visible);
        legend.chart.update('none');
        config[key] = widget.config[key] = visible;
        const control = container.querySelector(`[data-rc-config="${key}"]`);
        if (control) control.checked = visible;
        // Finish Chart.js event dispatch before the dashboard can destroy and rebuild this chart.
        queueMicrotask(() => { if (current()) onConfigChange(); });
      };
      state.charts.push(new ChartRuntime(container.querySelector('[data-rc-chart]'), { type: 'line', data: { labels,
        datasets: series(config).map(([key, label, color, visibilityKey = key]) => ({ ...dataset(label, result.series.map((row) => row[key]), color), hidden: config[visibilityKey] === false })) }, options: mainOptions }));
      if (config.spread !== false) state.charts.push(new ChartRuntime(container.querySelector('[data-rc-spread]'), { type: 'line', data: { labels,
        datasets: [dataset('COR1M − RC21', result.series.map((row) => row.spread), '#f59e0b'),
          { ...dataset('Zero', result.series.map(() => 0), '#888894'), borderDash: [4, 4] }] }, options: options() }));
      publish(payload);
    } catch (error) {
      if (!current()) return;
      destroyCharts(state);
      container.innerHTML = `${controls(config)}<div class="ivrv-error" role="status">Unable to calculate correlation: ${escape(error?.message || error)}</div>`;
      bind(container, widget, onConfigChange);
      publish({ status: 'error', error: error?.message || String(error) });
    }
  }
};
