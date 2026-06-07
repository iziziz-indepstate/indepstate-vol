import { calculateAtmStraddle } from '../../shared/atm-straddle-calculations.mjs';

const TENORS = ['0DTE', '1D', '1W', '2W', '1M', '2M', '3M', '6M'];
const COMPARE_TO = ['previous_close', 'previous_snapshot', 'none'];
const EXPIRY_SELECTION = ['nearest', 'at_or_after', 'at_or_before'];

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
        <input data-straddle-param="atmStrikeOverride" type="number" value="${esc(cfg.atmStrikeOverride || '')}" placeholder="Auto" />
      </label>
      <label class="straddle-control-narrow">Spot S
        <input data-straddle-param="manualReferencePrice" type="number" value="${esc(cfg.manualReferencePrice || '')}" placeholder="Auto" />
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

function renderFull(snapshot) {
  return `
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

function renderCompact(snapshot) {
  const deltaStrad = snapshot.comparison?.deltaStraddlePct;
  return `
    <div class="straddle-compact">
      <div class="straddle-compact-title">Straddle ATM | ${esc(snapshot.symbol)} ${esc(snapshot.tenor)}</div>
      <div>K ${fmt(snapshot.atmStrike, 0)} | DTE ${fmt(snapshot.dte, 1)} | S ${fmt(snapshot.referencePrice)}</div>
      <div class="straddle-compact-value">${fmt(snapshot.straddle.mid)} pts / ${fmtPct(snapshot.straddle.impliedMovePct)}</div>
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
  requiresHistory: true,
  defaultTitle: 'Straddle ATM',
  defaultConfig: {
    symbol: 'SPX',
    tenor: '1W',
    expiryOverride: '',
    atmStrikeOverride: '',
    manualReferencePrice: '',
    referencePriceMode: 'spot',
    expirySelectionMode: 'nearest',
    quoteMode: 'mid',
    compareTo: 'previous_close',
    compact: false
  },
  render: async ({ container, snapshot, history, widget, widgetData, onConfigChange, onConfigBroadcast }) => {
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
      const hasManualReferencePrice = String(cfg.manualReferencePrice ?? '').trim() !== '';
      const result = await calculateAtmStraddle({
        ...cfg,
        expiryOverride: cfg.expiryOverride || undefined,
        manualReferencePrice: hasManualReferencePrice ? cfg.manualReferencePrice : undefined,
        referencePriceMode: hasManualReferencePrice ? 'manual' : 'spot',
        snapshot,
        snapshotTime: snapshot.time,
        comparisonSnapshot: comparisonSnapshot(history, snapshot, cfg.compareTo),
        compareTo: cfg.compareTo
      });
      const body = cfg.compact ? renderCompact(result) : renderFull(result);
      widgetData?.publish?.({
        type: atmStraddleWidget.type,
        status: 'ok',
        title: widget.title || atmStraddleWidget.defaultTitle,
        config: { ...cfg },
        snapshot: result
      });
      container.innerHTML = `${renderControls(cfg)}${body}`;
      bindControls(container, widget, onConfigChange, onConfigBroadcast);
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
