import { VIX_RESPONSE_MODEL } from '../../shared/vix-response-calculations.mjs';
import { ensureChartJsRuntime } from './widget-renderers.js';

const states = new WeakMap();
const SPX_PROVIDERS = ['yahoo', 'fred'];
const VIX_PROVIDERS = ['cboe', 'yahoo', 'fred'];
const PROVIDER_LABELS = { yahoo: 'Yahoo', fred: 'FRED', cboe: 'Cboe' };
const escape = (value) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const format = (value) => Number.isFinite(value) ? `${value > 0 ? '+' : ''}${value.toFixed(2)}` : '—';

function metric(label, value, unit) {
  return `<div><span>${label}</span><strong>${format(value)}${Number.isFinite(value) ? unit : ''}</strong></div>`;
}

function sourceSummary(label, source) {
  const cache = source?.stale ? ' · stale cache' : source?.cached ? ' · cache' : '';
  const actual = source?.provider ? PROVIDER_LABELS[source.provider] : 'unavailable';
  const selected = source?.requestedProvider && source.provider !== source.requestedProvider
    ? ` (${PROVIDER_LABELS[source.requestedProvider]} selected)` : '';
  const date = source?.latestDate ? ` · ${escape(source.latestDate)}` : '';
  return `<span>${label} / ${actual}${selected}${date}${cache}</span>`;
}

function providerSelect(label, key, choices, selected) {
  const options = choices.map((provider) => `<option value="${provider}"${provider === selected ? ' selected' : ''}>${PROVIDER_LABELS[provider]}</option>`);
  return `<label>${label}<select data-vix-config="${key}">${options.join('')}</select></label>`;
}

function chartConfig(rows, datasets, legend = true) {
  return {
    type: 'line',
    data: { labels: rows.map((row) => row.date), datasets },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: legend, labels: { color: '#eaeaf0', boxWidth: 10 } },
        tooltip: {
          filter: (item) => item.dataset.label !== 'Zero',
          callbacks: { label: (item) => `${item.dataset.label}: ${format(item.parsed.y)} pts` }
        }
      },
      scales: { x: { ticks: { color: '#aaaab5', maxTicksLimit: 8 } }, y: { ticks: { color: '#aaaab5' } } }
    }
  };
}

function dataset(label, data, borderColor) {
  return {
    label, data, borderColor, borderWidth: 1.5, spanGaps: false, pointHitRadius: 8,
    pointRadius: (context) => {
      const i = context.dataIndex;
      return data[i] !== null && data[i - 1] == null && data[i + 1] == null ? 2 : 0;
    }
  };
}

export const vixResponseWidget = {
  type: 'vix-response', defaultTitle: 'VIX. Response', mode: 'table', gridSpan: 6,
  refreshOnDashboardRefresh: false, defaultConfig: { spxProvider: 'yahoo', ivProvider: 'cboe', startDate: '', endDate: '' },
  destroy(container) {
    states.get(container)?.charts.forEach((chart) => chart.destroy());
    states.delete(container);
  },
  async render({ container, widget, widgetData, onConfigChange }) {
    vixResponseWidget.destroy(container);
    const state = { charts: [] };
    states.set(container, state);
    const current = () => states.get(container) === state;
    const config = { ...vixResponseWidget.defaultConfig, ...widget.config };
    if (!SPX_PROVIDERS.includes(config.spxProvider)) config.spxProvider = vixResponseWidget.defaultConfig.spxProvider;
    if (!VIX_PROVIDERS.includes(config.ivProvider)) config.ivProvider = vixResponseWidget.defaultConfig.ivProvider;
    const publish = (result) => widgetData?.publish?.({
      ...result, type: vixResponseWidget.type, title: widget.title || vixResponseWidget.defaultTitle, config
    });
    container.innerHTML = `<div class="ivrv-controls">
      <label>Start date<input type="date" data-vix-config="startDate" value="${escape(config.startDate)}"></label>
      <label>End date<input type="date" data-vix-config="endDate" value="${escape(config.endDate)}"></label>
      ${providerSelect('SPX provider', 'spxProvider', SPX_PROVIDERS, config.spxProvider)}
      ${providerSelect('VIX provider', 'ivProvider', VIX_PROVIDERS, config.ivProvider)}
      <button type="button" class="btn" data-vix-refresh>Refresh</button>
    </div><div data-vix-content class="rc-widget"></div>`;
    const button = container.querySelector('[data-vix-refresh]');
    const content = container.querySelector('[data-vix-content]');
    for (const control of container.querySelectorAll('[data-vix-config]')) {
      control.addEventListener('change', () => {
        widget.config ??= {};
        widget.config[control.dataset.vixConfig] = control.value;
        onConfigChange();
      });
    }

    async function load(forceRefresh = false) {
      button.disabled = true;
      button.textContent = 'Loading…';
      try {
        const { spxProvider, ivProvider, startDate, endDate } = config;
        const result = await window.appBridge.getVixResponse({ spxProvider, ivProvider, startDate, endDate, forceRefresh });
        if (!current()) return;
        const { latest, sources, series, residualBands, model, warnings, error } = result;
        const summary = sources.spx?.latestDate === latest?.date && sources.vix?.latestDate === latest?.date ? latest : null;
        const hasChart = series.some(({ actualChange }) => actualChange !== null);
        state.charts.forEach((chart) => chart.destroy());
        state.charts = [];
        content.innerHTML = `<div class="ivrv-summary rc-summary">
          ${metric('Residual', summary?.residual, ' pts')}
          ${metric('Actual ΔVIX', summary?.actualChange, ' pts')}
          ${metric('Expected ΔVIX', summary?.expectedChange, ' pts')}
          ${metric('SPX return', summary?.spxReturn, '%')}
        </div>
        <div class="ivrv-freshness">${escape(result.startDate)} – ${escape(result.endDate)} · Last session ${escape(latest?.date || 'unavailable')} · ${model.windowSessions} prior sessions</div>
        <div class="ivrv-source-meta">${sourceSummary('SPX', sources.spx)}${sourceSummary('VIX', sources.vix)}</div>
        ${error ? `<div class="ivrv-error" role="status">${escape(error)}</div>` : ''}
        ${warnings.map((warning) => `<div class="ivrv-warning" role="status">${escape(warning)}</div>`).join('')}
        ${hasChart ? `<div class="ivrv-charts">
          <div><h4>Actual and expected ΔVIX · points</h4><canvas data-vix-response-chart></canvas></div>
          <div><h4>Residual · actual minus expected · points${residualBands ? ' · ±3σ and ±4σ' : ''}</h4><canvas data-vix-residual-chart></canvas></div>
        </div>` : ''}`;
        publish(result);
        if (!hasChart) return;
        try {
          const Chart = await ensureChartJsRuntime();
          if (!current()) return;
          state.charts.push(new Chart(content.querySelector('[data-vix-response-chart]'), chartConfig(series, [
            dataset('Actual', series.map((row) => row.actualChange), '#38bdf8'),
            dataset('Expected', series.map((row) => row.expectedChange), '#a78bfa')
          ])));
          const residualDatasets = [
            dataset('Residual', series.map((row) => row.residual), '#f59e0b'),
            { ...dataset('Zero', series.map(() => 0), '#888894'), borderDash: [4, 4] }
          ];
          if (residualBands) {
            const { mean, sigma, upper, lower } = residualBands;
            const levels = [
              ['Mean + 3σ', upper, '#a78bfa'],
              ['Mean − 3σ', lower, '#a78bfa'],
              ['Mean + 4σ', mean + 4 * sigma, '#ef4444'],
              ['Mean − 4σ', mean - 4 * sigma, '#ef4444']
            ];
            for (const [label, level, color] of levels) {
              residualDatasets.push({ ...dataset(label, series.map(() => level), color), borderDash: [7, 4], order: 1 });
            }
          }
          state.charts.push(new Chart(content.querySelector('[data-vix-residual-chart]'), chartConfig(series, residualDatasets, false)));
        } catch (error) {
          if (!current()) return;
          content.querySelector('.ivrv-charts').textContent = `Charts unavailable. ${error.message}`;
          state.charts.forEach((chart) => chart.destroy());
          state.charts = [];
        }
      } catch (error) {
        if (!current()) return;
        state.charts.forEach((chart) => chart.destroy());
        state.charts = [];
        const message = error?.message || String(error);
        content.innerHTML = `<div class="ivrv-error" role="status">Unable to load VIX response. ${escape(message)}</div>`;
        publish({ status: 'error', latest: null, series: [], residualBands: null, model: VIX_RESPONSE_MODEL, sources: {}, warnings: [], error: message });
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
