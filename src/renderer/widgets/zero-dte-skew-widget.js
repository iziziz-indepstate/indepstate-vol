import { buildZeroDteSkewSeries, normalizeSkewDelta } from '../../shared/zero-dte-skew-calculations.mjs';

const iv = (value) => Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : 'n/a';
const vol = (value) => Number.isFinite(value) ? `${(value * 100).toFixed(2)} vol pts` : 'n/a';

export function zeroDteSkewTooltip({ dataset, dataIndex }) {
  const p = dataset?.pointMeta?.[dataIndex];
  if (!p) return [];
  if (p.boundary) return ['Session boundary'];
  const contracts = (side) => p[side].contracts.map((q) =>
    `${side.toUpperCase()} K ${q.strike}, delta ${q.delta.toFixed(4)}, IV ${iv(q.iv)}`);
  return [
    `Time: ${p.timestamp}`, `Expiration: ${p.expiration}`, `Target delta: ${p.targetDelta}`,
    `Skew: ${vol(p.skew)}`, `Put wing: ${vol(p.putWing)}`, `Call wing: ${vol(p.callWing)}`,
    `Put IV: ${iv(p.put.iv)}`, `Call IV: ${iv(p.call.iv)}`,
    `ATM strike: ${p.atmStrike ?? 'n/a'}, IV: ${iv(p.atmIV)}`,
    ...contracts('put'), ...contracts('call'), p.warning
  ].filter(Boolean);
}

export const zeroDteSkewWidget = {
  type: 'zero-dte-skew', defaultTitle: 'Skew. 0DTE',
  mode: 'timeseries-custom', chartRuntime: 'uplot', gridSpan: 3, requiresHistory: true,
  color: '#a78bfa', volPoints: true, showZeroLine: true, hoverTooltip: true,
  defaultConfig: { targetDelta: 0.25, expiration: 'today' },
  controls: { targetDelta: true, targetDeltaMax: 0.49, expiration: true },
  buildTimeSeries(history, widget) {
    const cfg = { ...zeroDteSkewWidget.defaultConfig, ...widget?.config };
    const delta = normalizeSkewDelta(cfg.targetDelta);
    const points = buildZeroDteSkewSeries(history, cfg);
    const chartPoints = [];
    points.forEach((p, i) => {
      const previous = points[i - 1];
      if (previous && (previous.sessionDate !== p.sessionDate || previous.expiration !== p.expiration)) {
        chartPoints.push({ boundary: true });
      }
      chartPoints.push(p);
    });
    return {
      title: `Skew. 0DTE · ${Math.round(delta * 100)}Δ · ${points.at(-1)?.expiration || cfg.expiration}`,
      labels: chartPoints.map((p) => p.boundary ? '' : new Date(p.timestamp).toLocaleTimeString()),
      datasets: [
        ['skew', `Skew${Math.round(delta * 100)}`, '#a78bfa'],
        ['putWing', `Put${Math.round(delta * 100)} − ATM`, '#38bdf8'],
        ['callWing', `Call${Math.round(delta * 100)} − ATM`, '#fb923c']
      ].map(([key, label, borderColor]) => ({
        label, borderColor, borderWidth: 1.5,
        data: chartPoints.map((p) => Number.isFinite(p[key]) ? p[key] * 100 : null),
        pointMeta: chartPoints, tooltipFormatter: zeroDteSkewTooltip
      })),
      chartOptions: { skewStatus: points.at(-1)?.warning || (points.length ? '' : 'No option-chain history yet.') }
    };
  }
};
