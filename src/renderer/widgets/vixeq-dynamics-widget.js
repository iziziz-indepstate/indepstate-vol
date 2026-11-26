import { CONTEXT_SESSIONS, VIXEQ_LAUNCH_DATE, VIXEQ_SERIES, explainVixeqDynamics } from '../../shared/vixeq-dynamics-calculations.mjs';
import { evaluateVolatilityRegime } from '../../shared/volatility-regime-engine.mjs';
import { ensureChartJsRuntime } from './widget-renderers.js';
import { renderVolatilityRegimePanel, selectRegimeResponse } from './volatility-regime-panel.js';

const states = new WeakMap();
const labels = { vixeq: 'VIXEQ', vix: 'VIX', spread: 'VIXEQ − VIX', cor1m: 'COR1M' };
const colors = { vixeq: '#38bdf8', vix: '#f59e0b', spread: '#a3e635', cor1m: '#a78bfa' };
const providers = { cboe: 'Cboe', fred: 'FRED', yahoo: 'Yahoo', local: 'Local CSV' };
const escape = (value) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

function number(value, signed = false) {
  if (!Number.isFinite(value)) return '—';
  const rounded = Number(value.toFixed(2));
  return `${signed && rounded > 0 ? '+' : ''}${rounded.toFixed(2)}`;
}

function metric(row, key) {
  return `<div><span>${labels[key]}</span><strong>${number(row?.[key])}</strong>
    <span title="Changes over 5 and 20 trading sessions">Δ5D ${number(row?.change5[key], true)} · Δ20D ${number(row?.change20[key], true)}</span></div>`;
}

function sourceSummary(key, source) {
  const cache = source?.stale ? ' · stale cache' : source?.cached ? ' · cache' : '';
  const date = source?.latestDate ? ` · ${escape(source.latestDate)}` : '';
  return `<span>${labels[key]} / ${providers[source?.provider] ?? 'unavailable'}${date}${cache}</span>`;
}

function line(label, data, color) {
  return {
    label, data, borderColor: color, backgroundColor: color, borderWidth: 1.5, spanGaps: false,
    pointRadius: ({ dataIndex }) => (
      data[dataIndex] !== null && data[dataIndex - 1] == null && data[dataIndex + 1] == null ? 2 : 0
    )
  };
}

function seriesLine(rows, key) {
  return line(labels[key], rows.map((row) => row[key]), colors[key]);
}

function spreadDatasets(rows, contributions) {
  if (!contributions) return [seriesLine(rows, 'spread')];
  return [
    { type: 'bar', label: '+ΔVIXEQ', data: rows.map(({ change5 }) => change5.vixeq), backgroundColor: colors.vixeq, order: 1, signed: true },
    { type: 'bar', label: '−ΔVIX', data: rows.map(({ change5 }) => change5.vix === null ? null : -change5.vix),
      backgroundColor: colors.vix, order: 1, signed: true },
    { label: 'Δ spread', data: rows.map(({ change5 }) => change5.spread), showLine: false, pointRadius: 3,
      backgroundColor: colors.spread, borderColor: colors.spread, order: 0, signed: true }
  ];
}

function sharedHover(state) {
  return {
    id: 'vixeq-shared-hover',
    afterEvent(chart, args) {
      if (args.replay) return;
      const index = args.inChartArea && args.event.type !== 'mouseout' ? chart.scales.x.getValueForPixel(args.event.x) : null;
      const active = index === null ? [] : chart.data.datasets.flatMap((dataset, datasetIndex) => (
        chart.isDatasetVisible(datasetIndex) && dataset.data[index] != null ? [{ datasetIndex, index }] : []
      ));
      chart.tooltip.setActiveElements(active, { x: args.event.x, y: args.event.y });
      args.changed = true;
      if (index === state.hoverIndex) return;
      state.hoverIndex = index;
      for (const peer of state.charts) {
        if (peer === chart) continue;
        peer.tooltip.setActiveElements([], { x: 0, y: 0 });
        peer.draw();
      }
    },
    afterDatasetsDraw({ ctx, chartArea, scales }) {
      if (state.hoverIndex === null) return;
      const x = scales.x.getPixelForValue(state.hoverIndex);
      ctx.save();
      ctx.strokeStyle = '#9ca3af';
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x, chartArea.top);
      ctx.lineTo(x, chartArea.bottom);
      ctx.stroke();
      ctx.restore();
    }
  };
}

function retrospectiveShade(rows) {
  const first = rows.findIndex(({ retrospective }) => retrospective);
  const last = rows.findLastIndex(({ retrospective }) => retrospective);
  return {
    id: 'vixeq-retrospective',
    beforeDatasetsDraw({ ctx, chartArea, scales }) {
      if (first === -1) return;
      const left = scales.x.getPixelForValue(first - 0.5);
      const right = scales.x.getPixelForValue(last + 0.5);
      ctx.save();
      ctx.fillStyle = 'rgba(138, 161, 196, 0.13)';
      ctx.fillRect(left, chartArea.top, right - left, chartArea.bottom - chartArea.top);
      ctx.restore();
    }
  };
}

function chartConfig(rows, datasets, plugins) {
  return {
    type: 'line', data: { labels: rows.map(({ date }) => date), datasets }, plugins,
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      layout: { autoPadding: false, padding: { right: 8 } },
      plugins: {
        legend: { labels: { color: '#eaeaf0', boxWidth: 10 } },
        tooltip: {
          events: [],
          callbacks: {
            label: (item) => `${item.dataset.label}: ${number(item.parsed.y, item.dataset.signed)} pts`,
            afterBody: ([{ dataIndex }]) => {
              const { zScore, retrospective } = rows[dataIndex];
              return [
                `VIXEQ Z: ${number(zScore.vixeq, true)} · Spread Z: ${number(zScore.spread, true)}`,
                ...(retrospective ? ['VIXEQ: back-tested history'] : [])
              ];
            }
          }
        }
      },
      scales: {
        x: { offset: true, ticks: { color: '#aaaab5', maxTicksLimit: 7, minRotation: 0, maxRotation: 0 } },
        y: {
          afterFit: (scale) => { scale.width = 48; },
          ticks: { color: '#aaaab5', maxTicksLimit: 5 },
          grid: { color: ({ tick }) => tick.value === 0 ? '#737884' : 'rgba(180, 188, 205, 0.16)' }
        }
      }
    }
  };
}

function destroyCharts(state) {
  state.charts.forEach((chart) => chart.destroy());
  state.charts = [];
  state.hoverIndex = null;
}

function renderCharts(Chart, content, rows, state, spreadView, onViewChange) {
  const hover = sharedHover(state);
  const shade = retrospectiveShade(rows);
  const addChart = (key, datasets, plugins) => {
    const canvas = content.querySelector(`[data-vixeq-chart="${key}"]`);
    const chart = new Chart(canvas, chartConfig(rows, datasets, plugins));
    state.charts.push(chart);
    return chart;
  };
  addChart('volatility', [seriesLine(rows, 'vixeq'), seriesLine(rows, 'vix')], [hover, shade]);
  const contributions = spreadView === 'contributions';
  const spread = addChart('spread', spreadDatasets(rows, contributions), [hover, shade]);
  addChart('correlation', [seriesLine(rows, 'cor1m')], [hover]);
  spread.options.scales.y.beginAtZero = contributions;
  if (contributions) spread.update('none');

  content.querySelector('[data-vixeq-view]').addEventListener('change', (event) => {
    const contributions = event.target.value === 'contributions';
    onViewChange(contributions ? 'contributions' : 'level');
    spread.tooltip.setActiveElements([], { x: 0, y: 0 });
    spread.data.datasets = spreadDatasets(rows, contributions);
    spread.options.scales.y.beginAtZero = contributions;
    spread.update('none');
  });
}

export const vixeqDynamicsWidget = {
  type: 'vixeq-dynamics', defaultTitle: 'VIX. VIXEQ Dynamics', mode: 'table', gridSpan: 6, consumesWidgetData: true,
  refreshOnDashboardRefresh: false, waitForWidgetData: false,
  defaultConfig: { startDate: '', endDate: '', vixeqLocalSource: '', spreadView: 'level', responseWidgetId: '', regimeCollapsed: false },
  destroy(container) {
    const state = states.get(container);
    if (state) {
      state.unsubscribe?.();
      destroyCharts(state);
    }
    states.delete(container);
  },
  async render({ container, widget, widgets = [], widgetData, onConfigChange }) {
    vixeqDynamicsWidget.destroy(container);
    const state = { charts: [], hoverIndex: null };
    states.set(container, state);
    const current = () => states.get(container) === state;
    const config = { ...vixeqDynamicsWidget.defaultConfig, ...widget.config };
    if (config.spreadView !== 'contributions') config.spreadView = vixeqDynamicsWidget.defaultConfig.spreadView;
    config.regimeCollapsed = config.regimeCollapsed === true;
    let result;
    let regime;
    const publish = () => widgetData?.publish?.({
      ...result, regime, type: vixeqDynamicsWidget.type, title: widget.title || vixeqDynamicsWidget.defaultTitle, config: { ...config }
    });
    container.innerHTML = `<details class="volatility-regime" data-vixeq-regime${config.regimeCollapsed ? '' : ' open'}>
      <summary>Market Regime</summary>
      <div data-vixeq-regime-content><p role="status">Loading market observations…</p></div>
    </details><div class="ivrv-controls vixeq-controls">
      <label>Start date<input type="date" data-vixeq-config="startDate" value="${escape(config.startDate)}"></label>
      <label>End date<input type="date" data-vixeq-config="endDate" value="${escape(config.endDate)}"></label>
      <label>VIXEQ local CSV<input type="text" data-vixeq-config="vixeqLocalSource" value="${escape(config.vixeqLocalSource)}" placeholder="Optional path"></label>
      <button type="button" class="btn" data-vixeq-refresh>Refresh</button>
    </div><div class="rc-widget vixeq-widget" data-vixeq-content></div>`;
    const button = container.querySelector('[data-vixeq-refresh]');
    const content = container.querySelector('[data-vixeq-content]');
    const details = container.querySelector('[data-vixeq-regime]');
    const panel = container.querySelector('[data-vixeq-regime-content]');

    details.addEventListener('toggle', () => {
      const collapsed = !details.open;
      if (!current() || collapsed === config.regimeCollapsed) return;
      widget.config ??= {};
      widget.config.regimeCollapsed = collapsed;
      config.regimeCollapsed = collapsed;
      onConfigChange({ refresh: false });
      if (result) publish();
    });

    function updateRegime() {
      if (!current() || !result) return;
      const response = selectRegimeResponse(widgets, widgetData?.readByType?.('vix-response') ?? [], config.responseWidgetId);
      regime = evaluateVolatilityRegime({ ...result, ...response });
      renderVolatilityRegimePanel(panel, regime, response, config.responseWidgetId, (responseWidgetId) => {
        widget.config ??= {};
        widget.config.responseWidgetId = responseWidgetId;
        config.responseWidgetId = responseWidgetId;
        onConfigChange({ refresh: false });
        updateRegime();
        panel.querySelector('[data-regime-source]')?.focus();
      });
      publish();
    }

    state.unsubscribe = widgetData?.subscribeByType?.('vix-response', ({ widgetId } = {}) => {
      if (!regime || regime.data_quality.response_widget_id === widgetId) updateRegime();
    });
    for (const control of container.querySelectorAll('[data-vixeq-config]')) {
      control.addEventListener('change', () => {
        widget.config ??= {};
        widget.config[control.dataset.vixeqConfig] = control.value;
        onConfigChange();
      });
    }

    async function load(forceRefresh = false) {
      button.disabled = true;
      button.textContent = 'Loading…';
      try {
        const { startDate, endDate, vixeqLocalSource } = config;
        const loaded = await window.appBridge.getVixeqDynamics({ startDate, endDate, vixeqLocalSource, forceRefresh });
        if (!current()) return;
        result = loaded;
        destroyCharts(state);
        const { latest, sources, series, summary, warnings, error, status } = result;
        const retrospective = series.some((row) => row.retrospective);
        const explanation = explainVixeqDynamics(latest);
        const contributions = config.spreadView === 'contributions';
        content.innerHTML = `<div class="ivrv-freshness">${escape(result.startDate)} – ${escape(result.endDate)} · Last session ${escape(latest?.date ?? '—')}</div>
          <div class="ivrv-summary rc-summary">${['vixeq', 'vix', 'spread', 'cor1m'].map((key) => metric(latest, key)).join('')}</div>
          ${summary ? `<p class="vixeq-summary"><strong>5 sessions</strong> · ${escape(summary)}</p>` : ''}
          ${explanation ? `<p class="vixeq-explanation">${escape(explanation)}</p>` : ''}
          <div class="ivrv-source-meta">${VIXEQ_SERIES.map((key) => sourceSummary(key, sources[key])).join('')}</div>
          ${error ? `<div class="ivrv-error" role="status">${escape(error)}</div>` : ''}
          ${warnings.map((warning) => `<div class="ivrv-warning" role="status">${escape(warning)}</div>`).join('')}
          ${status !== 'error' ? `<div class="ivrv-charts rc-charts vixeq-charts">
            <div><h4>Implied volatility · vol points</h4><div class="vixeq-plot"><canvas data-vixeq-chart="volatility" role="img" aria-label="Daily VIXEQ and VIX"></canvas></div></div>
            <div><div class="vixeq-chart-header"><h4>Spread · vol points</h4>
              <select data-vixeq-view aria-label="Spread chart view">
                <option value="level"${contributions ? '' : ' selected'}>Level</option>
                <option value="contributions"${contributions ? ' selected' : ''}>5-session contributions</option>
              </select></div><div class="vixeq-plot"><canvas data-vixeq-chart="spread" role="img" aria-label="Daily spread or its 5-session contributions"></canvas></div></div>
            <div><h4>Implied correlation · correlation points</h4><div class="vixeq-plot"><canvas data-vixeq-chart="correlation" role="img" aria-label="Daily COR1M"></canvas></div></div>
          </div>
          <div class="ivrv-freshness vixeq-chart-note">Z-scores use ${CONTEXT_SESSIONS} prior sessions.${retrospective ? ` Shading marks back-tested VIXEQ before ${VIXEQ_LAUNCH_DATE}.` : ''}</div>` : ''}`;
        updateRegime();
        if (status === 'error') return;
        try {
          const Chart = await ensureChartJsRuntime();
          if (!current()) return;
          renderCharts(Chart, content, series, state, config.spreadView, (spreadView) => {
            widget.config ??= {};
            widget.config.spreadView = spreadView;
            config.spreadView = spreadView;
            onConfigChange({ refresh: false });
            publish();
          });
        } catch (error) {
          if (!current()) return;
          destroyCharts(state);
          content.querySelector('.vixeq-charts').textContent = `Charts unavailable. ${error.message}`;
        }
      } catch (error) {
        if (!current()) return;
        destroyCharts(state);
        const message = error?.message || String(error);
        content.innerHTML = `<div class="ivrv-error" role="status">Unable to load VIXEQ dynamics. ${escape(message)}</div>`;
        result = { status: 'error', startDate: config.startDate, endDate: config.endDate, latest: null, series: [],
          sources: {}, warnings: [], summary: '', error: message };
        updateRegime();
      } finally {
        if (current()) {
          button.disabled = false;
          button.textContent = 'Refresh';
        }
      }
    }

    button.addEventListener('click', () => load(true));
    await load();
  }
};
