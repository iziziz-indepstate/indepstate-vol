import { REGIME_RULES } from '../../shared/volatility-regime-rules.mjs';

const LABELS = { vix: 'VIX', vixeq: 'VIXEQ', cor1m: 'COR1M', spread: 'Spread' };
const QUALITY = {
  missing_session: 'No completed session in this range.',
  missing_source: 'Source unavailable.',
  stale_source: 'Source data are stale.',
  misaligned_session: 'Source has no matching session.',
  missing_observation: 'Required observation unavailable.',
  insufficient_history: 'Insufficient history.',
  zero_standard_deviation: 'Historical standard deviation is zero.',
  insufficient_response_history: 'Residual or training history unavailable.',
  missing_response_widget: 'Add VIX. Response to this tab to include Risk Response.',
  select_response_widget: 'Select a VIX. Response instance.',
  response_widget_removed: 'The selected VIX. Response is unavailable on this tab.',
  response_not_published: 'Waiting for the selected VIX. Response to publish.',
  missing_response: 'VIX. Response reported an error.'
};
const escape = (value) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const number = (value, signed = false) => Number.isFinite(value) ? `${signed && value > 0 ? '+' : ''}${value.toFixed(2)}` : '—';

export function selectRegimeResponse(widgets, outputs, selectedId) {
  const candidates = widgets.filter(({ type }) => type === 'vix-response');
  const selected = selectedId ? candidates.find(({ id }) => id === selectedId) : candidates.length === 1 ? candidates[0] : null;
  if (selected) {
    return { candidates, responseWidgetId: selected.id, response: outputs.find(({ widgetId }) => widgetId === selected.id),
      unavailableReason: 'response_not_published' };
  }
  return { candidates, responseWidgetId: selectedId || null,
    unavailableReason: selectedId ? 'response_widget_removed' : candidates.length ? 'select_response_widget' : 'missing_response_widget' };
}

function levels(metrics) {
  return Object.entries(metrics).map(([key, { value, z, reason }]) =>
    `<span title="${escape(QUALITY[reason])}">${LABELS[key]} ${number(value)} · Z ${number(z, true)}</span>`).join('');
}

function momentum(metrics) {
  return Object.entries(metrics).map(([key, { change, momentum: value, reason }]) =>
    `<span title="${escape(QUALITY[reason])}">${LABELS[key]} Δ ${number(change, true)} · M ${number(value, true)}</span>`).join('');
}

function tone(id) {
  if (id === 'UNKNOWN') return 'unknown';
  if (['SYSTEMIC_STRESS', 'ACUTE_STRESS', 'EXTREME_STRESS_RESPONSE'].includes(id)) return 'high';
  if (['SYSTEMIC_RISK', 'INDEX_VOL_RISK', 'FRAGILE_INDEX', 'DISPERSION_RISK', 'CORRELATION_RISK', 'ELEVATED_RISK_NORMAL_RESPONSE',
    'EMERGING_STRESS', 'STRESS_RESPONSE', 'SYSTEMIC_ESCALATION', 'SYNCHRONIZED_VOL_EXPANSION', 'ACUTE_RELIEF_ELEVATED_RISK'].includes(id)) return 'elevated';
  if (id.includes('RELIEF') || id === 'BROAD_NORMALIZATION' || id === 'VOLATILITY_COMPRESSION') return 'relief';
  return 'ordinary';
}

function card(title, regime, details, help) {
  return `<div class="regime-card" data-regime-tone="${tone(regime.id)}">
    <h4><abbr title="${escape(help)}">${title}</abbr></h4>
    <strong>${escape(regime.label)}</strong><p>${escape(regime.description)}</p>
    <div class="regime-evidence">${details}</div></div>`;
}

function implications(title, items) {
  if (!items.length) return '';
  return `<div><strong>${title}</strong><ul>${items.map(({ label, text }) =>
    `<li><span>${escape(label)}</span> · ${escape(text)}</li>`).join('')}</ul></div>`;
}

export function renderVolatilityRegimePanel(panel, regime, { candidates, responseWidgetId }, selectedId, onSourceChange) {
  const { risk_environment: environment, diversification_state: diversification, stress_dynamics_5d: short,
    stress_dynamics_20d: medium, risk_response: response, combined_state: combined, metric_levels, data_quality } = regime;
  const { z, residual, sigma, spxReturn, expectedChange, actualChange } = response.supporting_metrics;
  const selector = candidates.length > 1 || (selectedId && !candidates.some(({ id }) => id === selectedId))
    ? `<label>VIX. Response<select data-regime-source><option value="">${candidates.length === 1 ? 'Automatic' : 'Select source'}</option>
      ${candidates.map(({ id, title }) => `<option value="${escape(id)}"${id === selectedId ? ' selected' : ''}>${escape(title || 'VIX. Response')}${candidates.filter((widget) => widget.title === title).length > 1 ? ` · ${escape(id)}` : ''}</option>`).join('')}
      </select></label>`
    : '';
  const source = candidates.find(({ id }) => id === responseWidgetId);
  const levelHelp = `Daily level Z-score vs 252 prior sessions. Low cutoffs ${REGIME_RULES.thresholds.level.slice(0, 2).join(', ')}. High cutoffs ${REGIME_RULES.thresholds.level.slice(2).join(', ')}.`;
  const momentumHelp = `M = change divided by the standard deviation of 252 prior valid changes. Falling ≤ ${REGIME_RULES.thresholds.momentum[0]}. Rising ≥ ${REGIME_RULES.thresholds.momentum[1]}.`;
  const stressHelp = `${momentumHelp} Stress rules use the first matching combination of VIXEQ, VIX and COR1M.`;
  const responseHelp = `Residual = actual minus expected ΔVIX for the observed SPX return. Z = residual / prior training σ. Cutoffs ${REGIME_RULES.thresholds.response.join(', ')}.`;
  panel.innerHTML = `<div class="regime-header">
    <span>${escape(regime.as_of_date || 'No completed session')}${data_quality.retrospective_vixeq ? ' · Back-tested VIXEQ' : ''}</span>${selector}</div>
    <div class="regime-grid">
    ${card('Combined Market State', combined, `<span>${escape(environment.label)} · ${escape(response.label)} (Z ${number(z, true)})</span>`,
      'Combines the risk environment and the same-session VIX response.')}
    ${card('Risk Environment', environment, levels(Object.fromEntries(Object.entries(metric_levels).map(([key, item]) =>
      [key, item.supporting_metrics]))), `${levelHelp} Risk rules use the first matching combination of VIX, VIXEQ and COR1M levels.`)}
    ${card('Diversification Benefit', diversification, levels({ cor1m: diversification.supporting_metrics.level })
      + momentum({ cor1m: diversification.supporting_metrics.change20 }), `COR1M level and 20-session momentum. ${momentumHelp}`)}
    ${card('Short-Term Stress Dynamics (5D)', short, momentum(short.supporting_metrics), stressHelp)}
    ${card('Medium-Term Stress Dynamics (20D)', medium, momentum(medium.supporting_metrics), stressHelp)}
    ${card('Risk Response', response, `<span>SPX ${number(spxReturn, true)}%</span><span>Expected ΔVIX ${number(expectedChange, true)}</span>
      <span>Actual ΔVIX ${number(actualChange, true)}</span><span>Residual ${number(residual, true)}</span><span>σ ${number(sigma)}</span>
      <span>Z ${number(z, true)}</span>`, responseHelp)}
    </div>
    ${data_quality.response ? `<p class="regime-note">${escape(QUALITY[data_quality.response])}</p>`
      : source ? `<p class="regime-note">Response source · ${escape(source.title || 'VIX. Response')}</p>` : ''}
    <div class="regime-implications"><h4>Trading Implications</h4>
      ${implications('Risk management', regime.risk_management_implications)}
      ${implications('Strategy considerations', regime.strategy_considerations)}
      ${regime.risk_management_implications.length ? '' : '<p>No configured implications for these states.</p>'}
    </div><p class="regime-direction"><strong>Directional Bias</strong> · Undetermined</p>`;
  panel.querySelector('[data-regime-source]')?.addEventListener?.('change', ({ target }) => onSourceChange(target.value));
}
