import { buildNDeltaIVSeries, normalizeExpiryKey } from '../../shared/n-delta-iv-calculations.mjs';

function fmtPct(value, digits = 1) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(digits)}%` : 'n/a';
}

function fmtNum(value, digits = 2) {
  return Number.isFinite(value) ? Number(value).toFixed(digits) : 'n/a';
}

function fmtDelta(value) {
  return Number.isFinite(value) ? Number(value).toFixed(3) : 'n/a';
}

function deltaLabel(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${Math.round(Math.abs(n) * 100)}D` : 'nD';
}

function displayExpiry(value) {
  const key = normalizeExpiryKey(value);
  if (/^\d{8}$/.test(key)) return `${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}`;
  return key || 'n/a';
}

function pointTooltip(context) {
  const meta = context?.dataset?.pointMeta?.[context.dataIndex] || {};
  const label = context?.dataset?.label || 'Series';
  const value = context?.parsed?.y;
  const lines = [
    `${label}: ${fmtPct(value, label.includes('ATM') || label.includes('IV') ? 1 : 2)}`,
    `Timestamp: ${meta.timestamp || 'n/a'}`,
    `Expiration: ${displayExpiry(meta.expiration)}`,
    `Option type: ${String(meta.optionType || '').toUpperCase() || 'n/a'}`,
    `Target delta: ${fmtDelta(meta.targetDelta)}`,
    `Anchor strike: ${fmtNum(meta.anchorStrike, 0)}`,
    `Matched strike: ${fmtNum(meta.matchedStrike, 0)}`,
    `Matched delta: ${fmtDelta(meta.matchedDelta)}`,
    `nD IV: ${fmtPct(meta.deltaIV)}`,
    `ATM strike: ${fmtNum(meta.atmStrike, 0)}`,
    `ATM IV: ${fmtPct(meta.atmIV)}`,
    `nD IV - ATM IV: ${fmtPct(meta.deltaIVPremium, 2)}`
  ];
  if (meta.warning) lines.push(`Warning: ${meta.warning}`);
  return lines;
}

export const nDeltaIVWidget = {
  type: 'n-delta-iv',
  mode: 'timeseries-custom',
  gridSpan: 3,
  defaultTitle: 'n-Delta IV',
  color: '#38bdf8',
  requiresHistory: true,
  hideXAxisValues: true,
  defaultConfig: {
    symbol: 'SPX',
    baseStrike: 'ATM',
    optionType: 'put',
    targetDelta: 0.25,
    expiration: '',
    showPremiumSpread: true
  },
  controls: {
    strike: true,
    strikeInputType: 'text',
    optionType: true,
    targetDelta: true,
    expiration: true
  },
  buildTimeSeries: (history, widget) => {
    const cfg = { ...nDeltaIVWidget.defaultConfig, ...(widget?.config || {}) };
    const points = buildNDeltaIVSeries(history, cfg);
    const labels = points.map((point) => {
      const dt = new Date(point.timestamp || 0);
      return Number.isNaN(dt.getTime()) ? String(point.timestamp || '') : dt.toLocaleTimeString();
    });
    const optionLabel = String(cfg.optionType || 'put').toUpperCase();
    const baseDataset = {
      borderWidth: 1,
      tension: 0.2,
      pointRadius: 0,
      pointHitRadius: 14,
      pointHoverRadius: 4,
      pointMeta: points,
      tooltipFormatter: pointTooltip
    };

    const datasets = [
      {
        ...baseDataset,
        label: `${optionLabel} ${deltaLabel(cfg.targetDelta)} IV`,
        data: points.map((point) => point.deltaIV),
        borderColor: '#38bdf8'
      },
      {
        ...baseDataset,
        label: 'ATM IV',
        data: points.map((point) => point.atmIV),
        borderColor: '#facc15'
      }
    ];

    if (cfg.showPremiumSpread !== false) {
      datasets.push({
        ...baseDataset,
        label: `${optionLabel} ${deltaLabel(cfg.targetDelta)} IV - ATM IV`,
        data: points.map((point) => point.deltaIVPremium),
        borderColor: '#fb7185'
      });
    }

    return { labels, datasets };
  }
};
