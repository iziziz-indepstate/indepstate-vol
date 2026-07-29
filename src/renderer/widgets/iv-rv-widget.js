import { calculateIvRvSeries, resolveHorizon } from '../../shared/iv-rv-calculations.mjs';
import { ensureChartJsRuntime } from './widget-renderers.js';

const chartPairs = new WeakMap();
const renderVersions = new WeakMap();
const forceRefreshWidgets = new WeakSet();

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function format(value, digits = 2, suffix = '') {
  return Number.isFinite(value) ? `${value.toFixed(digits)}${suffix}` : 'n/a';
}

function selected(value, expected) {
  return value === expected ? ' selected' : '';
}

function checked(value) {
  return value ? ' checked' : '';
}

function subtractCalendarBuffer(startDate, horizonDays) {
  if (!startDate) return '';
  const date = new Date(`${startDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return startDate;
  date.setUTCDate(date.getUTCDate() - Math.ceil((horizonDays + 20) * 1.6));
  return date.toISOString().slice(0, 10);
}

function destroyCharts(container) {
  const pair = chartPairs.get(container);
  pair?.forEach((chart) => chart.destroy());
  chartPairs.delete(container);
}

function lineDataset(label, data, color) {
  return {
    label,
    data,
    borderColor: color,
    borderWidth: 1.5,
    pointRadius: 0,
    pointHitRadius: 0,
    pointHoverRadius: 0,
    tension: 0.15
  };
}

async function createCharts(container, result) {
  await ensureChartJsRuntime();
  const labels = result.series.map((row) => row.date);
  const commonOptions = {
    responsive: true,
    events: ['click'],
    animation: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: true, labels: { color: '#eaeaf0', boxWidth: 10 } },
      tooltip: { enabled: false }
    },
    scales: {
      x: { ticks: { color: 'rgba(234,234,240,0.65)', maxTicksLimit: 8 } },
      y: { ticks: { color: 'rgba(234,234,240,0.65)' } }
    }
  };

  const volChart = new Chart(container.querySelector('[data-ivrv-vol-chart]'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        lineDataset(result.series.at(-1)?.iv_symbol || 'IV', result.series.map((row) => row.iv), '#a78bfa'),
        lineDataset(`RV ${result.horizon.days}D`, result.series.map((row) => row.rv), '#22c55e')
      ]
    },
    options: commonOptions
  });

  const ratioChart = new Chart(container.querySelector('[data-ivrv-ratio-chart]'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        lineDataset('Vol ratio', result.series.map((row) => row.vol_ratio), '#38bdf8'),
        lineDataset('Variance ratio', result.series.map((row) => row.variance_ratio), '#f59e0b'),
        { ...lineDataset('Ratio 1.0', result.series.map(() => 1), 'rgba(234,234,240,0.45)'), borderDash: [5, 5] }
      ]
    },
    options: commonOptions
  });

  chartPairs.set(container, [volChart, ratioChart]);
}

function configMarkup(config) {
  const isLocal = config.dataMode === 'local';
  const isCustomHorizon = config.horizon === 'custom';
  const ivSymbol = config.horizon === '9d'
    ? 'VIX9D'
    : (config.horizon === '30d' ? 'VIX' : config.customIvSymbol);
  const effectiveIvProvider = ivSymbol === 'VIX9D' && config.ivProvider === 'fred'
    ? 'cboe'
    : config.ivProvider;
  return `
    <div class="ivrv-controls">
      <label class="ivrv-data-mode">Data mode
        <select data-ivrv-config="dataMode">
          <option value="local"${selected(config.dataMode, 'local')}>Local</option>
          <option value="remote"${selected(config.dataMode, 'remote')}>Remote</option>
          <option value="hybrid"${selected(config.dataMode, 'hybrid')}>Hybrid</option>
        </select>
      </label>
      <label>Horizon
        <select data-ivrv-config="horizon">
          <option value="9d"${selected(config.horizon, '9d')}>9D / VIX9D</option>
          <option value="30d"${selected(config.horizon, '30d')}>30D / VIX</option>
          <option value="custom"${selected(config.horizon, 'custom')}>Custom</option>
        </select>
      </label>
      <label class="${isCustomHorizon ? '' : 'is-hidden'}">Custom days
        <input type="number" min="1" data-ivrv-config="customDays" value="${escapeHtml(config.customDays || 60)}" />
      </label>
      <label class="${isCustomHorizon ? '' : 'is-hidden'}">Custom IV symbol
        <select data-ivrv-config="customIvSymbol">
          <option value="VIX"${selected(config.customIvSymbol, 'VIX')}>VIX</option>
          <option value="VIX9D"${selected(config.customIvSymbol, 'VIX9D')}>VIX9D</option>
        </select>
      </label>
      <label>Annualization
        <input type="number" min="1" data-ivrv-config="annualizationFactor" value="${escapeHtml(config.annualizationFactor)}" />
      </label>
      <label>Start date
        <input type="date" data-ivrv-config="startDate" value="${escapeHtml(config.startDate)}" />
      </label>
      <label>End date
        <input type="date" data-ivrv-config="endDate" value="${escapeHtml(config.endDate)}" />
      </label>
      <label class="${isLocal ? 'is-hidden' : ''}">SPX provider
        <select data-ivrv-config="spxProvider">
          <option value="fred"${selected(config.spxProvider, 'fred')}>FRED</option>
          <option value="yahoo"${selected(config.spxProvider, 'yahoo')}>Yahoo</option>
        </select>
      </label>
      <label class="${isLocal ? 'is-hidden' : ''}">IV provider
        <select data-ivrv-config="ivProvider">
          <option value="cboe"${selected(effectiveIvProvider, 'cboe')}>Cboe</option>
          ${ivSymbol === 'VIX' ? `<option value="fred"${selected(effectiveIvProvider, 'fred')}>FRED</option>` : ''}
          <option value="yahoo"${selected(effectiveIvProvider, 'yahoo')}>Yahoo</option>
        </select>
      </label>
      <label class="ivrv-local-control${isLocal ? '' : ' is-hidden'}">SPX local CSV/JSON
        <input data-ivrv-config="spxSource" value="${escapeHtml(config.spxSource)}" placeholder="C:\\data\\spx_daily.csv" />
      </label>
      <label class="ivrv-local-control${isLocal ? '' : ' is-hidden'}">IV local CSV/JSON
        <input data-ivrv-config="ivSource" value="${escapeHtml(config.ivSource)}" placeholder="C:\\data\\vix9d_daily.csv" />
      </label>
      <label class="ivrv-cache-check${isLocal ? ' is-hidden' : ''}">
        <input type="checkbox" data-ivrv-config="cache"${checked(config.cache)} /> Cache
      </label>
      <button type="button" class="btn" data-ivrv-load>Load data</button>
    </div>
  `;
}

function bindControls(container, widget, onConfigChange) {
  container.querySelectorAll('[data-ivrv-config]').forEach((control) => {
    control.addEventListener('change', () => {
      const key = control.dataset.ivrvConfig;
      widget.config[key] = control.type === 'checkbox' ? control.checked : control.value;
      onConfigChange();
    });
  });
  container.querySelector('[data-ivrv-load]')?.addEventListener('click', () => {
    forceRefreshWidgets.add(widget);
    onConfigChange();
  });
}

export const ivRvWidget = {
  type: 'iv-rv-local',
  mode: 'table',
  gridSpan: 6,
  defaultTitle: 'SPX IV / RV',
  refreshOnDashboardRefresh: false,
  defaultConfig: {
    horizon: '9d',
    dataMode: 'remote',
    customDays: 60,
    customIvSymbol: 'VIX',
    annualizationFactor: 252,
    startDate: '',
    endDate: '',
    spxProvider: 'fred',
    ivProvider: 'cboe',
    cache: true,
    spxSource: '',
    ivSource: ''
  },
  destroy: destroyCharts,
  render: async ({ container, widget, onConfigChange }) => {
    const renderVersion = (renderVersions.get(container) || 0) + 1;
    renderVersions.set(container, renderVersion);
    destroyCharts(container);
    widget.config ||= {};
    delete widget.config.cacheTtlMinutes;
    const config = { ...ivRvWidget.defaultConfig, ...widget.config };
    const forceRefresh = forceRefreshWidgets.has(widget);
    forceRefreshWidgets.delete(widget);
    if (!['fred', 'yahoo'].includes(config.spxProvider)) {
      config.spxProvider = 'fred';
      widget.config.spxProvider = 'fred';
    }
    if (!['cboe', 'fred', 'yahoo'].includes(config.ivProvider)) {
      config.ivProvider = 'cboe';
      widget.config.ivProvider = 'cboe';
    }
    const configuredIvSymbol = config.horizon === '9d'
      ? 'VIX9D'
      : (config.horizon === '30d' ? 'VIX' : config.customIvSymbol);
    if (configuredIvSymbol === 'VIX9D' && config.ivProvider === 'fred') {
      config.ivProvider = 'cboe';
      widget.config.ivProvider = 'cboe';
    }
    const horizon = config.horizon === 'custom' ? `${config.customDays}d` : config.horizon;

    container.innerHTML = `${configMarkup(config)}<div class="ivrv-status">Configure providers and load data.</div>`;
    bindControls(container, widget, onConfigChange);
    if (config.dataMode === 'local' && (!config.spxSource || !config.ivSource)) return;

    const status = container.querySelector('.ivrv-status');
    status.textContent = 'Loading market data...';

    try {
      const resolvedHorizon = resolveHorizon(horizon);
      const ivSymbol = resolvedHorizon.ivSymbol || config.customIvSymbol;
      const spxStartDate = subtractCalendarBuffer(config.startDate, resolvedHorizon.days);
      const common = {
        dataMode: config.dataMode,
        endDate: config.endDate,
        cache: config.cache,
        forceRefresh
      };
      const [spxResult, ivResult] = await Promise.all([
        window.appBridge.getDailyMarketHistory({
          ...common,
          symbol: 'SPX',
          provider: config.spxProvider,
          localSource: config.spxSource,
          startDate: spxStartDate
        }),
        window.appBridge.getDailyMarketHistory({
          ...common,
          symbol: ivSymbol,
          provider: config.ivProvider,
          localSource: config.ivSource,
          startDate: config.startDate
        })
      ]);
      const result = calculateIvRvSeries({
        spxRows: spxResult.bars,
        ivRows: ivResult.bars,
        horizon,
        annualizationFactor: config.annualizationFactor,
        startDate: config.startDate,
        endDate: config.endDate
      });
      if (renderVersions.get(container) !== renderVersion) return;
      const latest = result.series.at(-1);
      const latestIvDate = ivResult.bars.at(-1)?.date || null;
      const spxLagWarning = latestIvDate && result.latestSpxDate && latestIvDate > result.latestSpxDate
        ? `SPX close for ${latestIvDate} is not available yet. RV calculated using latest available SPX close: ${result.latestSpxDate}.`
        : '';
      container.innerHTML = `
        ${configMarkup(config)}
        <div class="ivrv-summary">
          <div><span>Horizon</span><strong>${result.horizon.label.toUpperCase()}</strong></div>
          <div><span>Latest IV</span><strong>${format(latest.iv)}</strong></div>
          <div><span>Latest RV</span><strong>${format(latest.rv)}</strong></div>
          <div><span>Vol spread</span><strong>${format(latest.vol_spread, 2, ' vol pts')}</strong></div>
          <div><span>Vol ratio</span><strong>${format(latest.vol_ratio, 2, 'x')}</strong></div>
          <div><span>Variance ratio</span><strong>${format(latest.variance_ratio, 2, 'x')}</strong></div>
        </div>
        <div class="ivrv-source-meta">
          <span>IV symbol: <strong>${ivSymbol}</strong></span>
          <span>SPX source: <strong>${spxResult.provider.toUpperCase()}</strong>${spxResult.cached ? ' (cache)' : ''}</span>
          <span>IV source: <strong>${ivResult.provider.toUpperCase()}</strong>${ivResult.cached ? ' (cache)' : ''}</span>
          <span>Last updated: <strong>${escapeHtml(ivResult.updatedAt || spxResult.updatedAt || 'local snapshot')}</strong></span>
        </div>
        <div class="ivrv-freshness">Last calculation: ${latest.date}. Latest available SPX close: ${result.latestSpxDate}.</div>
        ${spxResult.fallback ? `<div class="ivrv-warning">SPX fallback provider used: ${spxResult.provider.toUpperCase()}.</div>` : ''}
        ${ivResult.fallback ? `<div class="ivrv-warning">${ivSymbol} fallback provider used: ${ivResult.provider.toUpperCase()}.</div>` : ''}
        ${spxResult.warning ? `<div class="ivrv-warning">${escapeHtml(spxResult.warning)}</div>` : ''}
        ${ivResult.warning ? `<div class="ivrv-warning">${escapeHtml(ivResult.warning)}</div>` : ''}
        ${spxLagWarning ? `<div class="ivrv-warning">${escapeHtml(spxLagWarning)}</div>` : ''}
        ${latest.ratio_warning ? `<div class="ivrv-warning">${latest.ratio_warning}</div>` : ''}
        <div class="ivrv-charts">
          <div><h4>IV vs RV</h4><canvas data-ivrv-vol-chart></canvas></div>
          <div><h4>Ratios</h4><canvas data-ivrv-ratio-chart></canvas></div>
        </div>
      `;
      bindControls(container, widget, onConfigChange);
      await createCharts(container, result);
    } catch (error) {
      if (renderVersions.get(container) !== renderVersion) return;
      const currentStatus = container.querySelector('.ivrv-status') || status;
      currentStatus.textContent = `Unable to calculate IV/RV: ${error?.message || String(error)}`;
      currentStatus.classList.add('ivrv-error');
    }
  }
};
