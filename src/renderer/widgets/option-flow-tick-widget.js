import { withUnderlying } from './option-flow-chart.js';
import {
  buildOptionFlowBalancedTickSeries,
  buildOptionFlowTickSeries
} from '../../shared/option-flow-tick-calculations.mjs';
import { formatOptionFlowStrikeWindow } from '../../shared/option-flow-strike-window.mjs';

function fmt(value, digits = 0) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : 'n/a';
}

function flowModeTooltip(meta) {
  if (meta.displayMode === 'linear') return 'Mode: linear';
  return meta.flowWindowMinutes
    ? `Mode: MA ${fmt(meta.flowWindowMinutes)}m`
    : 'Mode: cumulative';
}

function normalizeDisplayPointOffset(value) {
  const number = Math.floor(Math.abs(Number(value)));
  return Number.isFinite(number) ? number : 0;
}

function normalizeDisplayPointLimit(value) {
  if (value == null || value === '') return null;
  const number = Math.floor(Math.abs(Number(value)));
  return Number.isFinite(number) && number > 0 ? number : null;
}

function applyDisplayPointWindow(series, config = {}) {
  const labels = Array.isArray(series?.labels) ? series.labels : [];
  const offset = normalizeDisplayPointOffset(config.displayPointOffset);
  const limit = normalizeDisplayPointLimit(config.displayPointLimit);
  const offsetStart = Math.min(offset, labels.length);
  const start = limit == null
    ? offsetStart
    : Math.max(offsetStart, labels.length - limit);
  const end = labels.length;

  return {
    labels: labels.slice(start, end),
    datasets: (Array.isArray(series?.datasets) ? series.datasets : []).map((dataset) => ({
      ...dataset,
      data: Array.isArray(dataset?.data) ? dataset.data.slice(start, end) : dataset?.data,
      pointMeta: Array.isArray(dataset?.pointMeta) ? dataset.pointMeta.slice(start, end) : dataset?.pointMeta
    }))
  };
}

function pointTooltip(context) {
  const meta = context?.dataset?.pointMeta?.[context.dataIndex] || {};
  const label = context?.dataset?.label || 'Series';
  const value = context?.parsed?.y;
  const key = context?.dataset?.seriesKey;
  const increment = meta.increments?.[key];
  return [
    `${label}: ${fmt(value)}`,
    `Increment: ${fmt(increment)}`,
    `Timestamp: ${meta.timestamp || 'n/a'}`,
    `ATM px: ${fmt(meta.px, 2)}`,
    `Strike window: ${formatOptionFlowStrikeWindow(meta.strikeWindow)}`,
    flowModeTooltip(meta),
    `Matched records: ${fmt(meta.matchedRecords)} / ${fmt(meta.records)}`
  ];
}

function balancedPointTooltip(context) {
  const meta = context?.dataset?.pointMeta?.[context.dataIndex] || {};
  const label = context?.dataset?.label || 'Series';
  const value = context?.parsed?.y;
  const key = context?.dataset?.seriesKey;
  const callIncrement = (meta.increments?.boughtCalls || 0) - (meta.increments?.soldCalls || 0);
  const putIncrement = (meta.increments?.boughtPuts || 0) - (meta.increments?.soldPuts || 0);
  const grossIncrement = (
    (meta.increments?.boughtCalls || 0)
    + (meta.increments?.soldCalls || 0)
    + (meta.increments?.boughtPuts || 0)
    + (meta.increments?.soldPuts || 0)
  );
  const increment = key === 'callsBalance'
    ? callIncrement
    : key === 'putsBalance'
      ? putIncrement
      : key === 'directionalBalance'
        ? callIncrement - putIncrement
        : grossIncrement > 0
          ? (callIncrement - putIncrement) / grossIncrement
          : 0;
  const digits = key === 'imbalance' ? 4 : 0;
  return [
    `${label}: ${fmt(value, digits)}`,
    `Increment: ${fmt(increment, digits)}`,
    `Timestamp: ${meta.timestamp || 'n/a'}`,
    `ATM px: ${fmt(meta.px, 2)}`,
    `Strike window: ${formatOptionFlowStrikeWindow(meta.strikeWindow)}`,
    flowModeTooltip(meta),
    `Matched records: ${fmt(meta.matchedRecords)} / ${fmt(meta.records)}`
  ];
}

export const optionFlowTickWidget = {
  type: 'option-flow-tick',
  mode: 'timeseries-custom',
  chartRuntime: 'uplot',
  gridSpan: 3,
  defaultTitle: 'Option Flow TICK',
  color: '#22c55e',
  requiresHistory: true,
  hideXAxisValues: false,
  optionFlow: true,
  defaultConfig: {
    showUnderlying: false,
    strikeWindow: 3,
    flowDisplayMode: 'cumulative',
    displayPointOffset: '',
    displayPointLimit: ''
  },
  controls: {
    showUnderlying: true,
    strikeWindow: true,
    flowDisplayMode: true,
    displayPointOffset: true,
    displayPointLimit: true
  },
  buildTimeSeries: (history, widget) => {
    const cfg = { ...optionFlowTickWidget.defaultConfig, ...(widget?.config || {}) };
    const series = applyDisplayPointWindow(buildOptionFlowTickSeries(history, cfg), cfg);
    return withUnderlying({
      labels: series.labels,
      datasets: series.datasets.map((dataset) => ({
        ...dataset,
        borderWidth: 1,
        tension: 0.2,
        pointRadius: 0,
        pointHitRadius: 0,
        pointHoverRadius: 0,
        tooltipFormatter: pointTooltip
      }))
    }, cfg, 'px');
  }
};

export const optionFlowBalancedTickWidget = {
  type: 'option-flow-balanced-tick',
  mode: 'timeseries-custom',
  chartRuntime: 'uplot',
  gridSpan: 3,
  defaultTitle: 'Option Flow Balanced TICK',
  color: '#38bdf8',
  requiresHistory: true,
  hideXAxisValues: false,
  optionFlow: true,
  defaultConfig: {
    showUnderlying: false,
    strikeWindow: 3,
    flowDisplayMode: 'cumulative',
    displayPointOffset: '',
    displayPointLimit: ''
  },
  controls: {
    showUnderlying: true,
    strikeWindow: true,
    flowDisplayMode: true,
    displayPointOffset: true,
    displayPointLimit: true
  },
  buildTimeSeries: (history, widget) => {
    const cfg = { ...optionFlowBalancedTickWidget.defaultConfig, ...(widget?.config || {}) };
    const series = applyDisplayPointWindow(buildOptionFlowBalancedTickSeries(history, cfg), cfg);
    return withUnderlying({
      labels: series.labels,
      datasets: series.datasets.map((dataset) => ({
        ...dataset,
        borderWidth: 1,
        tension: 0.2,
        pointRadius: 0,
        pointHitRadius: 0,
        pointHoverRadius: 0,
        tooltipFormatter: balancedPointTooltip
      }))
    }, cfg, 'px');
  }
};
