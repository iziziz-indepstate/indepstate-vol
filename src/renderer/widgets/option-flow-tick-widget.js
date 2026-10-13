import { buildOptionFlowTickSeries } from '../../shared/option-flow-tick-calculations.mjs';

function fmt(value, digits = 0) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : 'n/a';
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
    `Strike window: +/-${fmt(meta.strikeWindow)}`,
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
  hideXAxisValues: true,
  defaultConfig: {
    strikeWindow: 3
  },
  controls: {
    strikeWindow: true
  },
  buildTimeSeries: (history, widget) => {
    const cfg = { ...optionFlowTickWidget.defaultConfig, ...(widget?.config || {}) };
    const series = buildOptionFlowTickSeries(history, cfg);
    return {
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
    };
  }
};
