import { calculateAtmStraddle } from '../../shared/atm-straddle-calculations.mjs';
import { ATM_STRADDLE_POINT_EVENT, buildAtmStraddlePoint } from '../../shared/atm-straddle-point.mjs';
import { ensureUPlotRuntime } from './widget-renderers.js';

const TENORS = ['0DTE', '1D', '1W', '2W', '1M', '2M', '3M', '6M'];
const COMPARE_TO = ['previous_close', 'previous_snapshot', 'none'];
const EXPIRY_SELECTION = ['nearest', 'at_or_after', 'at_or_before'];
const sparklineCharts = new WeakMap();
const renderVersions = new WeakMap();
const emittedPointKeysByContainer = new WeakMap();

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[ch]));
}

function fmt(value, digits = 2) {
  return Number.isFinite(value) ? Number(value).toFixed(digits) : 'n/a';
}

function fmtPct(value, digits = 2) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(digits)}%` : 'n/a';
}

function fmtIv(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : 'n/a';
}

function fmtTime(value) {
  const dt = new Date(value || 0);
  return Number.isNaN(dt.getTime()) ? String(value || '') : dt.toLocaleTimeString();
}

function option(value, selected) {
  return `<option value="${esc(value)}" ${String(value) === String(selected) ? 'selected' : ''}>${esc(value)}</option>`;
}

function dateInputValue(value) {
  const raw = String(value || '').trim();
  if (/^\d{8}$/.test(raw)) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  return '';
}

const BADGE_TOOLTIPS = Object.freeze({
  VOL_CRUSH: 'Selected expiry is repricing movement lower: straddle is down more than 5% and ATM IV is lower versus comparison.',
  MOVEMENT_BID: 'ATM movement is still being bought: straddle or ATM IV is flat/up versus comparison.',
  SPOT_UP_VOL_UP: 'Spot is higher and ATM IV is higher. A bounce with vol still bid can be fragile.',
  SPOT_DOWN_VOL_DOWN: 'Spot is lower and ATM IV is lower. Weak spot is not being confirmed by ATM vol stress.',
  LOW_CONFIDENCE: 'Use caution: quote spread is wide, data is stale, or comparison data is missing.',
  OK: 'Quote quality is acceptable: bid/ask are valid, spread is within threshold, and data is not stale.',
  WIDE_SPREAD: 'Bid/ask spread is wider than the normal threshold, so the straddle value is less reliable.',
  MISSING_BID_ASK: 'Bid or ask is missing on one side of the ATM pair.',
  STALE_QUOTE: 'Quote timestamp is older than the freshness threshold.',
  NEGATIVE_OR_INVALID_QUOTE: 'Bid/ask/mid is invalid, negative, or crossed.',
  manual_strike: 'ATM strike was manually set from the ATM K control.',
  explicit_atm: 'ATM strike was explicitly requested by ATM K and selected nearest to the reference price.',
  nearest_to_reference: 'ATM strike was selected as the valid call/put pair nearest to the reference price.',
  delta_neutral_fallback: 'ATM strike was selected by minimizing call delta plus put delta because reference price was unavailable.'
});

function snapshotDay(snapshot) {
  const dt = new Date(snapshot?.time || 0);
  if (Number.isNaN(dt.getTime())) return '';
  return dt.toISOString().slice(0, 10);
}

function comparisonSnapshot(history, latest, mode) {
  if (mode === 'none' || !Array.isArray(history) || history.length < 2) return null;
  const latestTime = String(latest?.time || '');
  const candidates = history.filter((snap) => snap && String(snap.time || '') !== latestTime);
  if (!candidates.length) return null;
  if (mode === 'previous_snapshot') return candidates[candidates.length - 1];

  const latestDay = snapshotDay(latest);
  for (let idx = candidates.length - 1; idx >= 0; idx -= 1) {
    if (snapshotDay(candidates[idx]) && snapshotDay(candidates[idx]) !== latestDay) return candidates[idx];
  }
  return candidates[candidates.length - 1];
}

function renderControls(cfg) {
  const expiryValue = dateInputValue(cfg.expiryOverride);
  const expiryControl = !cfg.compact || expiryValue ? `
      <label>Expiry
        <input data-straddle-param="expiryOverride" type="date" value="${esc(expiryValue)}" />
      </label>
  ` : '';
  const advancedControls = cfg.compact ? '' : `
      <label>Pick
        <select data-straddle-param="expirySelectionMode">${EXPIRY_SELECTION.map((x) => option(x, cfg.expirySelectionMode || 'nearest')).join('')}</select>
      </label>
      <label>Compare
        <select data-straddle-param="compareTo">${COMPARE_TO.map((x) => option(x, cfg.compareTo || 'previous_close')).join('')}</select>
      </label>
  `;
  return `
    <div class="straddle-controls">
      <label>Tenor
        <select data-straddle-param="tenor">${TENORS.map((x) => option(x, cfg.tenor || '1W')).join('')}</select>
      </label>
      ${expiryControl}
      <label class="straddle-control-narrow">ATM K
        <input data-straddle-param="atmStrikeOverride" type="text" value="${esc(cfg.atmStrikeOverride || '')}" placeholder="ATM" />
      </label>
      <label class="straddle-control-narrow">Spot S
        <input data-straddle-param="manualReferencePrice" type="text" value="${esc(cfg.manualReferencePrice || '')}" placeholder="Auto" />
      </label>
      ${advancedControls}
      <label class="straddle-checkbox">
        <input data-straddle-param="compact" type="checkbox" ${cfg.compact ? 'checked' : ''} />
        Compact
      </label>
    </div>
  `;
}

function renderBadges(values) {
  return values.map((value) => {
    const tooltip = BADGE_TOOLTIPS[value] || 'Straddle status tag.';
    return `<span class="straddle-badge" title="${esc(tooltip)}">${esc(value)}</span>`;
  }).join(' ');
}

function renderComparison(snapshot) {
  if (!snapshot.comparison) return '<div class="straddle-section"><div class="straddle-muted">Comparison: unavailable</div></div>';
  const c = snapshot.comparison;
  const label = c.mode === 'previous_snapshot' ? 'previous snapshot' : 'previous close';
  return `
    <div class="straddle-section">
      <div class="straddle-heading">Vs ${esc(label)}</div>
      <div>Delta Straddle: ${fmt(c.deltaStraddlePts)} pts / ${fmtPct(c.deltaStraddlePct, 1)}</div>
      <div>Delta ATM IV: ${Number.isFinite(c.deltaAtmIv) ? `${(c.deltaAtmIv * 100).toFixed(1)} vol pts` : 'n/a'}</div>
      <div>Delta S: ${fmt(c.deltaUnderlying)} pts</div>
    </div>
  `;
}

function manualReferenceParams(cfg) {
  const manualReferenceRaw = String(cfg.manualReferencePrice ?? '').trim();
  const manualReferenceToken = manualReferenceRaw.toUpperCase();
  const hasManualReferencePrice = manualReferenceRaw !== ''
    && manualReferenceToken !== 'AUTO'
    && manualReferenceToken !== 'ATM';
  return {
    manualReferencePrice: hasManualReferencePrice ? cfg.manualReferencePrice : undefined,
    referencePriceMode: hasManualReferencePrice ? 'manual' : 'spot'
  };
}

async function buildPriceHistory(history, cfg, currentResult) {
  if (!Array.isArray(history) || history.length < 2) return [];
  const params = manualReferenceParams(cfg);
  const selected = history.slice(-120);
  const points = [];

  for (const snap of selected) {
    if (!snap) continue;
    try {
      const result = await calculateAtmStraddle({
        ...cfg,
        ...params,
        expiryOverride: cfg.expiryOverride || undefined,
        snapshot: snap,
        snapshotTime: snap.time,
        compareTo: 'none'
      });
      const point = buildAtmStraddlePoint(result);
      if (!point) continue;
      points.push({
        ...point,
        label: fmtTime(snap.time),
        snapshot: result
      });
    } catch (_err) {
      // Historical snapshots may not all contain the selected expiry/strike.
    }
  }

  const currentTime = String(currentResult?.snapshotTime || '');
  const lastTime = String(points[points.length - 1]?.time || '');
  const currentPoint = buildAtmStraddlePoint(currentResult);
  if (currentPoint && currentTime && currentTime !== lastTime) {
    points.push({
      ...currentPoint,
      label: fmtTime(currentResult.snapshotTime),
      snapshot: currentResult
    });
  }

  return points;
}

export function atmStraddlePointEventKey(point, config = {}) {
  if (!point) return '';
  const snapshot = point.snapshot || {};
  return [
    point.time,
    snapshot.tenor || config.tenor || '',
    snapshot.expiry || config.expiryOverride || '',
    point.atmStrike,
    config.referencePriceMode || 'spot',
    config.quoteMode || 'mid'
  ].map((value) => String(value ?? '')).join('|');
}

export function emitAtmStraddlePointEvent(eventPort, { point, result, config, widget, title } = {}) {
  const sourcePoint = point || buildAtmStraddlePoint(result);
  const snapshot = result || point?.snapshot;
  if (!sourcePoint || !snapshot) return false;
  return Boolean(eventPort?.emit?.(ATM_STRADDLE_POINT_EVENT, {
    ...sourcePoint,
    snapshot,
    config: { ...(config || {}) },
    title: title || widget?.title || atmStraddleWidget.defaultTitle,
    widget: {
      id: widget?.id,
      type: widget?.type,
      title: widget?.title,
      config: { ...(widget?.config || {}) }
    }
  }));
}

export function emitAtmStraddlePriceHistoryEvents(eventPort, {
  points,
  config,
  widget,
  title,
  emittedKeys = new Set()
} = {}) {
  let emitted = 0;
  for (const point of Array.isArray(points) ? points : []) {
    const key = atmStraddlePointEventKey(point, config);
    if (!key || emittedKeys.has(key)) continue;
    if (!emitAtmStraddlePointEvent(eventPort, { point, config, widget, title })) continue;
    emittedKeys.add(key);
    emitted += 1;
  }
  return emitted;
}

function renderPriceSparkline(points) {
  const valid = Array.isArray(points) ? points.filter((point) => Number.isFinite(point?.value)) : [];
  if (valid.length < 2) {
    return '<div class="straddle-sparkline straddle-sparkline-empty"><span>Price history needs at least 2 matching snapshots.</span></div>';
  }

  const min = Math.min(...valid.map((point) => point.value));
  const max = Math.max(...valid.map((point) => point.value));
  const first = valid[0];
  const last = valid[valid.length - 1];
  const delta = last.value - first.value;
  const deltaPct = first.value ? delta / first.value : NaN;
  const trendClass = delta > 0 ? 'is-up' : delta < 0 ? 'is-down' : 'is-flat';

  return `
    <div class="straddle-sparkline ${trendClass}">
      <div class="straddle-sparkline-head">
        <span>Straddle price</span>
        <strong>${fmt(last.value)} pts</strong>
        <span>${Number.isFinite(deltaPct) ? `${delta >= 0 ? '+' : ''}${fmt(delta)} pts / ${deltaPct >= 0 ? '+' : ''}${fmtPct(deltaPct, 1)}` : 'n/a'}</span>
      </div>
      <div class="straddle-sparkline-chart" data-straddle-price-chart role="img" aria-label="Straddle price history"></div>
      <div class="straddle-sparkline-range">
        <span>${esc(first.label)}</span>
        <span>${fmt(min)}-${fmt(max)} pts</span>
        <span>${esc(last.label)}</span>
      </div>
    </div>
  `;
}

function destroySparklineChart(container) {
  sparklineCharts.get(container)?.destroy();
  sparklineCharts.delete(container);
}

async function renderPriceSparklineChart(container, points) {
  const host = container.querySelector('[data-straddle-price-chart]');
  if (!host) return;
  const valid = Array.isArray(points) ? points.filter((point) => Number.isFinite(point?.value)) : [];
  if (valid.length < 2) return;

  const UPlot = await ensureUPlotRuntime();
  const color = host.closest('.straddle-sparkline')?.classList.contains('is-up')
    ? '#23c55e'
    : (host.closest('.straddle-sparkline')?.classList.contains('is-down') ? '#fb7185' : '#7aa2ff');
  const width = Math.max(100, Math.round(host.clientWidth || host.getBoundingClientRect().width || 240));
  const height = 58;
  const chart = new UPlot({
    width,
    height,
    cursor: { show: false },
    legend: { show: false },
    scales: { x: { time: false } },
    axes: [
      { show: false, size: 0, grid: { show: false }, ticks: { show: false } },
      { show: false, size: 0, grid: { show: false }, ticks: { show: false } }
    ],
    series: [
      {},
      {
        label: 'Straddle price',
        stroke: color,
        width: 2,
        points: { show: false }
      }
    ]
  }, [
    valid.map((_, idx) => idx),
    valid.map((point) => point.value)
  ], host);
  sparklineCharts.set(container, chart);
}

function renderFull(snapshot, priceHistory) {
  return `
    ${renderPriceSparkline(priceHistory)}
    <pre class="straddle-text">${esc(`STRADDLE ATM | ${snapshot.symbol} ${snapshot.tenor} -> ${snapshot.expiry} | DTE ${fmt(snapshot.dte, 1)}
S: ${fmt(snapshot.referencePrice)} ${snapshot.referencePriceSource} | ATM K: ${fmt(snapshot.atmStrike, 0)}
ATM selection: ${snapshot.atmSelectionMethod}

Call: ${fmt(snapshot.call.mid)} mid | IV ${fmtIv(snapshot.call.iv)}
Put:  ${fmt(snapshot.put.mid)} mid | IV ${fmtIv(snapshot.put.iv)}

Straddle: ${fmt(snapshot.straddle.mid)} pts / ${fmtPct(snapshot.straddle.impliedMovePct)}
Bid/Ask: ${fmt(snapshot.straddle.bid)} / ${fmt(snapshot.straddle.ask)} | Spread: ${fmt(snapshot.straddle.spreadPts)} pts / ${fmtPct(snapshot.straddle.spreadPct, 1)}

Expected range:
${fmt(snapshot.straddle.expectedLow)} - ${fmt(snapshot.straddle.expectedHigh)}

ATM IV: ${fmtIv(snapshot.atmIv)}
Net Greeks:
Delta ${fmt(snapshot.netGreeks?.delta, 2)} | Gamma ${fmt(snapshot.netGreeks?.gamma, 4)} | Vega ${fmt(snapshot.netGreeks?.vega, 2)} | Theta ${fmt(snapshot.netGreeks?.theta, 2)}`)}</pre>
    ${renderComparison(snapshot)}
    <div class="straddle-footer">
      <span>State: ${renderBadges(snapshot.stateLabels.filter((x) => x !== 'LOW_CONFIDENCE'))}</span>
      <span>Quality: ${renderBadges(snapshot.qualityFlags)}</span>
      ${snapshot.stateLabels.includes('LOW_CONFIDENCE') ? `<span>Warning: ${renderBadges(['LOW_CONFIDENCE'])}</span>` : ''}
    </div>
  `;
}

function renderCompact(snapshot, priceHistory) {
  const deltaStrad = snapshot.comparison?.deltaStraddlePct;
  return `
    <div class="straddle-compact">
      <div class="straddle-compact-title">Straddle ATM | ${esc(snapshot.symbol)} ${esc(snapshot.tenor)}</div>
      <div>K ${fmt(snapshot.atmStrike, 0)} | DTE ${fmt(snapshot.dte, 1)} | S ${fmt(snapshot.referencePrice)}</div>
      <div class="straddle-compact-value">${fmt(snapshot.straddle.mid)} pts / ${fmtPct(snapshot.straddle.impliedMovePct)}</div>
      ${renderPriceSparkline(priceHistory)}
      <div>Range ${fmt(snapshot.straddle.expectedLow, 1)} - ${fmt(snapshot.straddle.expectedHigh, 1)}</div>
      <div>ATM IV ${fmtIv(snapshot.atmIv)} | DeltaStrad ${Number.isFinite(deltaStrad) ? fmtPct(deltaStrad, 1) : 'n/a'}</div>
      <div>State: ${renderBadges(snapshot.stateLabels.filter((x) => x !== 'LOW_CONFIDENCE'))} | Quality: ${renderBadges(snapshot.qualityFlags)}</div>
      ${snapshot.stateLabels.includes('LOW_CONFIDENCE') ? `<div>Warning: ${renderBadges(['LOW_CONFIDENCE'])}</div>` : ''}
    </div>
  `;
}

const BROADCAST_PARAMS = new Set(['atmStrikeOverride', 'manualReferencePrice']);

function bindControls(container, widget, onConfigChange, onConfigBroadcast) {
  container.querySelectorAll('[data-straddle-param]').forEach((el) => {
    el.addEventListener('change', (evt) => {
      const name = evt.target.dataset.straddleParam;
      widget.config ||= {};
      widget.config[name] = evt.target.type === 'checkbox' ? evt.target.checked : evt.target.value;
      onConfigChange();
    });

    el.addEventListener('click', (evt) => {
      const name = evt.target.dataset.straddleParam;
      if (!evt.ctrlKey || !BROADCAST_PARAMS.has(name)) return;
      const value = evt.target.value;
      widget.config ||= {};
      widget.config[name] = value;
      if (typeof onConfigBroadcast === 'function') onConfigBroadcast(name, value);
      onConfigChange();
      document.querySelectorAll(`[data-straddle-param="${name}"]`).forEach((otherInput) => {
        otherInput.value = value;
      });
    });
  });
}

export const atmStraddleWidget = {
  type: 'atm-straddle',
  mode: 'table',
  wide: false,
  eventContracts: [ATM_STRADDLE_POINT_EVENT],
  requiresHistory: true,
  defaultTitle: 'Straddle ATM',
  defaultConfig: {
    symbol: 'SPX',
    tenor: '1W',
    expiryOverride: '',
    atmStrikeOverride: '',
    manualReferencePrice: 'Auto',
    referencePriceMode: 'spot',
    expirySelectionMode: 'nearest',
    quoteMode: 'mid',
    compareTo: 'previous_close',
    compact: false
  },
  render: async ({ container, snapshot, history, widget, widgetData, eventPort, onConfigChange, onConfigBroadcast }) => {
    const renderVersion = (renderVersions.get(container) || 0) + 1;
    renderVersions.set(container, renderVersion);
    destroySparklineChart(container);
    const cfg = { ...atmStraddleWidget.defaultConfig, ...(widget.config || {}) };
    container.innerHTML = `${renderControls(cfg)}<div class="straddle-status">Loading...</div>`;
    bindControls(container, widget, onConfigChange, onConfigBroadcast);

    if (!snapshot) {
      widgetData?.publish?.({
        type: atmStraddleWidget.type,
        status: 'error',
        error: 'No option-chain snapshot available.'
      });
      container.querySelector('.straddle-status').textContent = 'No option-chain snapshot available.';
      return;
    }

    try {
      const referenceParams = manualReferenceParams(cfg);
      const effectiveConfig = { ...cfg, ...referenceParams };
      const result = await calculateAtmStraddle({
        ...effectiveConfig,
        expiryOverride: cfg.expiryOverride || undefined,
        snapshot,
        snapshotTime: snapshot.time,
        comparisonSnapshot: comparisonSnapshot(history, snapshot, cfg.compareTo),
        compareTo: cfg.compareTo
      });
      const priceHistory = await buildPriceHistory(history, cfg, result);
      const body = cfg.compact ? renderCompact(result, priceHistory) : renderFull(result, priceHistory);
      widgetData?.publish?.({
        type: atmStraddleWidget.type,
        status: 'ok',
        title: widget.title || atmStraddleWidget.defaultTitle,
        config: { ...cfg },
        snapshot: result,
        priceHistory
      });
      if (!emittedPointKeysByContainer.has(container)) emittedPointKeysByContainer.set(container, new Set());
      emitAtmStraddlePriceHistoryEvents(eventPort, {
        points: priceHistory,
        config: cfg,
        widget,
        emittedKeys: emittedPointKeysByContainer.get(container)
      });
      container.innerHTML = `${renderControls(cfg)}${body}`;
      bindControls(container, widget, onConfigChange, onConfigBroadcast);
      if (renderVersions.get(container) === renderVersion) {
        await renderPriceSparklineChart(container, priceHistory);
      }
    } catch (err) {
      widgetData?.publish?.({
        type: atmStraddleWidget.type,
        status: 'error',
        title: widget.title || atmStraddleWidget.defaultTitle,
        config: { ...cfg },
        error: err?.message || String(err)
      });
      container.innerHTML = `${renderControls(cfg)}<div class="straddle-error">${esc(err?.message || err)}</div>`;
      bindControls(container, widget, onConfigChange, onConfigBroadcast);
    }
  }
};
