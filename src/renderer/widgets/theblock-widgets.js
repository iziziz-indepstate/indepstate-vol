const RANGE_DAYS = Object.freeze({
  '1D': 1,
  '1W': 7,
  '1M': 31,
  '6M': 183
});

function latestTheBlockSnapshot(history) {
  for (let idx = (history || []).length - 1; idx >= 0; idx -= 1) {
    if (history[idx]?.theBlock?.charts) return history[idx];
  }
  return null;
}

function formatDateLabel(date, frequency, range) {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return date;
  const month = parsed.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  const day = parsed.getUTCDate();
  if (String(frequency).toLowerCase() === 'monthly') return `${month} ${parsed.getUTCFullYear()}`;
  if (range === '6M') return `${month} ${day}`;
  return `${day} ${month}`;
}

function filterPoints(points, range) {
  const source = Array.isArray(points) ? points : [];
  if (!source.length) return [];
  const latest = source.at(-1)?.timestamp;
  const days = RANGE_DAYS[range] || RANGE_DAYS['1M'];
  const cutoff = latest - days * 86400;
  const filtered = source.filter((point) => point.timestamp >= cutoff);
  if (filtered.length >= 2) return filtered;
  return source.slice(-Math.min(2, source.length));
}

function collectLabels(chart, range) {
  const labels = new Map();
  Object.values(chart?.series || {}).forEach((series) => {
    filterPoints(series.points, range).forEach((point) => {
      labels.set(point.date, formatDateLabel(point.date, chart.frequency, range));
    });
  });
  return Array.from(labels.entries()).sort((a, b) => a[0].localeCompare(b[0]));
}

function seriesDataForLabels(series, labelEntries, range) {
  const points = filterPoints(series?.points, range);
  const byDate = new Map(points.map((point) => [point.date, point.value]));
  return labelEntries.map(([date]) => byDate.get(date) ?? null);
}

function valueFormatter(format, digits = 2) {
  return (value) => {
    if (!Number.isFinite(value)) return 'n/a';
    if (format === 'currency') {
      const abs = Math.abs(value);
      if (abs >= 1e12) return `$${(value / 1e12).toFixed(1)}t`;
      if (abs >= 1e9) return `$${(value / 1e9).toFixed(1)}b`;
      if (abs >= 1e6) return `$${(value / 1e6).toFixed(1)}m`;
      return `$${value.toFixed(0)}`;
    }
    if (format === 'percent') return `${value.toFixed(digits)}%`;
    return value.toFixed(digits);
  };
}

function tooltipFormatter(format, digits = 2) {
  const formatter = valueFormatter(format, digits);
  return (context) => `${context?.dataset?.label || 'Series'}: ${formatter(Number(context?.parsed?.y))}`;
}

function makeDataset(chart, labelEntries, seriesName, options = {}) {
  const source = chart?.series?.[seriesName];
  return {
    label: options.label || seriesName,
    data: seriesDataForLabels(source, labelEntries, options.range),
    type: options.type || (String(source?.type).toLowerCase() === 'column' ? 'bar' : 'line'),
    yAxisID: options.yAxisID || 'y',
    borderColor: options.color,
    backgroundColor: options.backgroundColor || options.color,
    borderWidth: options.borderWidth ?? 1.7,
    pointRadius: 0,
    pointHitRadius: 0,
    pointHoverRadius: 0,
    tension: options.tension ?? 0.12,
    borderDash: options.borderDash,
    tooltipFormatter: tooltipFormatter(options.format, options.digits)
  };
}

function emptySeries(title) {
  return {
    title: '',
    labels: [],
    datasets: [],
    chartOptions: {
      plugins: {
        title: { display: false, text: '' }
      }
    }
  };
}

function buildTheBlockSeries(history, widget, spec) {
  const snapshot = latestTheBlockSnapshot(history);
  const chart = snapshot?.theBlock?.charts?.[spec.chartId];
  const range = widget?.config?.range || spec.defaultRange || '1M';
  if (!chart) return emptySeries(spec.title);

  const labelEntries = collectLabels(chart, range);
  const labels = labelEntries.map(([, label]) => label);
  const datasets = spec.datasets.map((dataset) => makeDataset(chart, labelEntries, dataset.series, {
    ...dataset,
    range
  }));

  return {
    title: '',
    labels,
    datasets,
    chartOptions: spec.chartOptions || {}
  };
}

function leftRightScales(left = {}, right = {}) {
  return {
    x: {
      offset: true,
      grid: { color: 'rgba(234,234,240,0.08)' },
      ticks: { color: 'rgba(234,234,240,0.66)', maxTicksLimit: 7 }
    },
    y: {
      position: 'left',
      grid: { color: 'rgba(234,234,240,0.10)' },
      ticks: { color: left.color || '#7aa2ff', callback: valueFormatter(left.format, left.digits) }
    },
    y1: {
      position: 'right',
      grid: { drawOnChartArea: false },
      ticks: { color: right.color || '#ff5151', callback: valueFormatter(right.format, right.digits) }
    }
  };
}

function singleScale(options = {}) {
  return {
    x: {
      grid: { color: 'rgba(234,234,240,0.08)' },
      ticks: { color: 'rgba(234,234,240,0.66)', maxTicksLimit: 7 }
    },
    y: {
      grid: { color: 'rgba(234,234,240,0.10)' },
      ticks: { color: options.color || 'rgba(234,234,240,0.72)', callback: valueFormatter(options.format, options.digits) }
    }
  };
}

function makeWidget(spec) {
  return {
    type: spec.type,
    mode: 'timeseries-custom',
    gridSpan: 3,
    defaultTitle: spec.title,
    requiresHistory: true,
    controls: { timeRange: true },
    defaultConfig: { range: spec.defaultRange || '1M' },
    buildTimeSeries: (history, widget) => buildTheBlockSeries(history, widget, spec)
  };
}

export const theBlockCmeBtcOptionsWidget = makeWidget({
  type: 'theblock-cme-btc-options',
  chartId: 'cmeBtcOptionsVolumeOi',
  title: 'Volume and OI of CME Bitcoin Options',
  defaultRange: '6M',
  datasets: [
    { series: 'CME Volume', type: 'bar', yAxisID: 'y', color: '#5b8ee6', backgroundColor: 'rgba(91,142,230,0.82)', format: 'currency' },
    { series: 'CME Open Interest', type: 'line', yAxisID: 'y1', color: '#ff4b4b', format: 'currency' }
  ],
  chartOptions: { scales: leftRightScales({ color: '#5b8ee6', format: 'currency' }, { color: '#ff4b4b', format: 'currency' }) }
});

export const theBlockBtcDvolVolOfVolWidget = makeWidget({
  type: 'theblock-btc-dvol-vol-of-vol',
  chartId: 'btcDvolVolOfVol',
  title: 'BTC DVol Index Vol of Vol',
  datasets: [
    { series: 'Vol of Vol', yAxisID: 'y', color: '#2f7dff', digits: 0 },
    { series: 'DVol Index', yAxisID: 'y1', color: '#ff4b4b', digits: 0 }
  ],
  chartOptions: { scales: leftRightScales({ color: '#2f7dff', digits: 0 }, { color: '#ff4b4b', digits: 0 }) }
});

export const theBlockBtcDvolVariancePremiumWidget = makeWidget({
  type: 'theblock-btc-dvol-variance-premium',
  chartId: 'btcDvolVariancePremium',
  title: 'BTC DVol Index Variance Premium',
  datasets: [
    { series: 'Parkinson 30-day HV', color: '#2f7dff', digits: 1 },
    { series: 'DVol Index', color: '#ff4b4b', digits: 1 },
    { series: 'Variance Premium', type: 'bar', color: '#18b7c9', backgroundColor: 'rgba(24,183,201,0.82)', digits: 1 }
  ],
  chartOptions: { scales: singleScale({ digits: 1 }) }
});

export const theBlockBtcAtmIvWidget = makeWidget({
  type: 'theblock-btc-atm-iv',
  chartId: 'btcAtmImpliedVolatility',
  title: 'BTC ATM Implied Volatility',
  datasets: [
    { series: '1 week', label: 'ATM 7', color: '#2f7dff', format: 'percent', digits: 1 },
    { series: '1 month', label: 'ATM 30', color: '#ff4b4b', format: 'percent', digits: 1 },
    { series: '3 months', label: 'ATM 90', color: 'rgba(99,208,230,0.45)', format: 'percent', digits: 1 },
    { series: '6 months', label: 'ATM 180', color: 'rgba(198,217,126,0.45)', format: 'percent', digits: 1 }
  ],
  chartOptions: { scales: singleScale({ format: 'percent', digits: 0 }) }
});

const skewDatasetSpecs = [
  { series: '7 Day Exp', color: '#2f7dff', digits: 1 },
  { series: '30 Day Exp', color: '#ff4b4b', digits: 1 },
  { series: '60 Day Exp', color: 'rgba(99,208,230,0.45)', digits: 1 },
  { series: '90 Day Exp', color: 'rgba(198,217,126,0.45)', digits: 1 },
  { series: '180 Day Exp', color: 'rgba(164,180,255,0.45)', digits: 1 }
];

export const theBlockBtcOptionSkewDelta5Widget = makeWidget({
  type: 'theblock-btc-option-skew-delta-5',
  chartId: 'btcOptionSkewDelta5',
  title: 'BTC Option Skew Delta 5',
  datasets: skewDatasetSpecs,
  chartOptions: { scales: singleScale({ digits: 1 }) }
});

export const theBlockBtcOptionSkewDelta25Widget = makeWidget({
  type: 'theblock-btc-option-skew-delta-25',
  chartId: 'btcOptionSkewDelta25',
  title: 'BTC Option Skew Delta 25',
  datasets: skewDatasetSpecs,
  chartOptions: { scales: singleScale({ digits: 1 }) }
});

export const theBlockWidgets = [
  theBlockCmeBtcOptionsWidget,
  theBlockBtcDvolVolOfVolWidget,
  theBlockBtcDvolVariancePremiumWidget,
  theBlockBtcAtmIvWidget,
  theBlockBtcOptionSkewDelta5Widget,
  theBlockBtcOptionSkewDelta25Widget
];
