import { withUnderlying } from './option-flow-chart.js';
import { createGammaFlowCalculator, GAMMA_DEFAULTS } from '../../shared/gamma-flow-calculations.mjs';

const calculateGammaFlow = createGammaFlowCalculator();

const fmt = (n) => Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 4 }) : 'N/A';
function details(p, relative = false, imbalance = false) {
  if (!p) return 'N/A — No tape-contract history';
  const lines = [
    `${p.timestamp} | ${p.settings.gammaMode === 'executed' ? 'Executed Gamma' : 'Revalued Gamma Proxy'} | Source gamma units`,
    `Net ${fmt(p.net)} | Gross ${fmt(p.gross)} | Bought ${fmt(p.gross == null ? null : p.bought)} | Sold ${fmt(p.gross == null ? null : p.sold)}`,
    `${p.completeCoverage ? 'Window covered' : 'Incomplete history'} | Activity threshold: ${p.activity} | Window starts ${p.windowStart || 'N/A'}`
  ];
  if (imbalance) lines.push(`B ${fmt(p.B)} | IV Pressure Z ${fmt(p.Z)} | Confirmed C ${fmt(p.C)}`);
  if (p.settings.gammaMode === 'revalued') {
    lines.push(`SPX spot ${fmt(p.currentSpot)} | Tape execution ${p.currentSpotTimestamp || 'N/A'}`);
    lines.push(`New trades ${fmt(p.newFlow)} | Leaving window ${fmt(p.expiredFlow)} | Revaluation ${fmt(p.revaluation)}`);
  }
  if (relative) {
    lines.push(`Asymmetry A ${fmt(p.A)} | Downside–Upside IV ${fmt(p.downsideUpsideSkew)} | Change ${fmt(p.deltaDownsideUpsideSkew)}`);
    for (const [name, s] of Object.entries(p.segments)) lines.push(`${name}: B ${fmt(s.B)} | Gross ${fmt(s.gross)} | IV ${fmt(s.ivEnd)} | Skew ${fmt(s.skew)} | ΔSkew ${fmt(s.deltaSkew)} | Z ${fmt(s.relativeZ)} | R ${fmt(s.R)} | ${s.activity}${s.reason ? ` | ${s.reason}` : ''}`);
  } else if (imbalance && p.C == null) {
    lines.push(...[...new Set(Object.values(p.segments).filter((s) => s.count > 0).map((s) => s.reason).filter(Boolean))]
      .map((reason) => `IV confirmation unavailable: ${reason}`));
  }
  if (p.reason) lines.push(`N/A — ${p.reason}`);
  const excluded = Object.entries(p.excluded).filter(([, n]) => n).map(([r, n]) => `${r}: ${n}`).join(', ');
  if (excluded) lines.push(`Excluded: ${excluded}`);
  if (p.excluded.execution_time) lines.push('Execution timestamps are missing or unreadable; check tape timestamp / executed_at.');
  lines.push('Observed transaction flow; not dealer inventory. Asymmetry is not a directional SPX forecast.');
  return lines.join('\n');
}
function build(history, widget, imbalance) {
  const cfg = { ...GAMMA_DEFAULTS, ...widget?.config };
  const points = calculateGammaFlow(history, cfg);
  const relative = imbalance && cfg.gammaAnalysis === 'relative';
  const defs = !imbalance ? [['net', 'Net Gamma', '#38bdf8']]
    : relative ? [
      ['segments.downside.R', 'Downside R', '#f59e0b'], ['segments.atm.R', 'ATM R', '#a855f7'],
      ['segments.upside.R', 'Upside R', '#22c55e'], ['A', 'Asymmetry A', '#38bdf8']
    ] : [['B', 'Raw B', '#38bdf8'], ['Z', 'IV Pressure Z', '#f59e0b', 'ivPressure'], ['C', 'Confirmed C', '#22c55e']];
  const datasets = defs.map(([path, label, color, scale]) => ({
    seriesKey: path, label, borderColor: color, yAxisID: scale || 'y',
    data: points.map((p) => path.split('.').reduce((v, k) => v?.[k], p) ?? null),
    pointMeta: points, borderWidth: 1.5,
    tooltipFormatter: (context) => details(points[context.dataIndex], relative, imbalance).split('\n')
  }));
  datasets.push({ label: 'Zero', data: points.map(() => 0), borderColor: '#888888',
    borderDash: [4, 4], hiddenInLegend: true, alwaysVisible: true, pointMeta: points });
  return withUnderlying({ labels: points.map((p) => p.timestamp), datasets,
    summary: points.at(-1) ?? null,
    chartOptions: { gammaDebug: cfg.gammaDebug === true, gammaSummary: details(points.at(-1), relative, imbalance),
      scales: { y: imbalance ? { min: -1, max: 1 } : {}, ivPressure: {} } } }, cfg, 'currentSpot');
}
function definition(imbalance) {
  return {
    type: imbalance ? 'option-flow-gamma-imbalance' : 'option-flow-gamma-flow',
    defaultTitle: imbalance ? 'Option Flow Gamma Imbalance' : 'Option Flow Gamma Flow',
    mode: 'timeseries-custom', chartRuntime: 'uplot', gridSpan: 3, requiresHistory: true,
    gammaFlow: true, optionFlow: true, hideXAxisValues: false, color: '#38bdf8',
    defaultConfig: { ...GAMMA_DEFAULTS, showUnderlying: false }, controls: { showUnderlying: true, gammaFlow: true, gammaAnalysis: imbalance },
    buildTimeSeries: (history, widget) => build(history, widget, imbalance)
  };
}
export const gammaFlowWidget = definition(false);
export const gammaImbalanceWidget = definition(true);
