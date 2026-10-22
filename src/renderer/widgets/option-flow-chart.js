// Append the optional series without changing the indices of the flow datasets.
export function withUnderlying(series, config, priceKey) {
  if (config.showUnderlying !== true) return series;
  const points = series.datasets[0]?.pointMeta || [];
  return {
    ...series,
    datasets: [...series.datasets, {
      seriesKey: 'underlying', label: 'Underlying', yAxisID: 'underlying',
      data: points.map((point) => Number.isFinite(point[priceKey]) && point[priceKey] > 0 ? point[priceKey] : null),
      pointMeta: points, borderColor: 'rgba(156,163,175,0.55)', borderWidth: 3,
      drawOrder: -1, hiddenInLegend: true, alwaysVisible: true
    }]
  };
}

export function localFlowTime(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return '';
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((value) => String(value).padStart(2, '0')).join(':');
}

// X remains an observation index. Only label whole observations, spaced for HH:mm:ss.
export function flowTimeSplits(plot, min, max, count) {
  const first = Math.max(0, Math.ceil(min));
  const last = Math.min(count - 1, Math.floor(max));
  if (last < first) return [];
  const width = plot.over?.clientWidth || plot.width || 100;
  const intervals = Math.max(1, Math.floor(width / 90));
  const step = Math.max(1, Math.ceil((last - first) / intervals));
  const splits = [];
  for (let idx = first; idx <= last; idx += step) splits.push(idx);
  return splits;
}
