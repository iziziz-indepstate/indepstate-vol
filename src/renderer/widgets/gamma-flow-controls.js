import { GAMMA_DEFAULTS } from '../../shared/gamma-flow-calculations.mjs';

const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function gammaControlVisible(name, config = {}, showAnalysis = false) {
  const c = { ...GAMMA_DEFAULTS, ...config };
  if (name === 'gammaWidth') return c.gammaStrikeScope !== 'explicit';
  if (name === 'gammaStrikes') return c.gammaStrikeScope === 'explicit';
  if (name === 'gammaAnchorAt') return c.gammaStrikeScope === 'anchored';
  if (name === 'gammaMinutes') return c.gammaWindow === 'rolling';
  if (name === 'gammaStart') return c.gammaWindow === 'anchored';
  if (name === 'gammaQuoteMaxAgeSeconds') return showAnalysis || c.gammaMode === 'revalued';
  return true;
}
export function syncGammaFlowControls(root, widget, showAnalysis) {
  root.querySelectorAll('[data-gamma-control]').forEach((label) => {
    if (label.dataset.gammaWidgetId === widget.id) label.hidden = !gammaControlVisible(label.dataset.gammaControl, widget.config, showAnalysis);
  });
}
export function gammaFlowControls(widget, showAnalysis) {
  const c = { ...GAMMA_DEFAULTS, ...widget.config };
  const attrs = (name) => `data-widget-param-widget-id="${escape(widget.id)}" data-widget-param-name="${name}"`;
  const select = (name, label, options) => `<label class="widget-control">${label}<select ${attrs(name)}>${options.map(([v, l]) => `<option value="${v}" ${c[name] === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`;
  const input = (name, label, hint, type = 'text') => `<label class="widget-control" data-gamma-control="${name}" data-gamma-widget-id="${escape(widget.id)}" ${gammaControlVisible(name, c, showAnalysis) ? '' : 'hidden'}>${label}<input type="${type}" ${attrs(name)} value="${escape(c[name])}" placeholder="${escape(hint)}" title="${escape(hint)}" ${type === 'number' ? 'min="0" step="1"' : ''}/></label>`;
  return [
    select('gammaMode', 'Gamma', [['executed', 'Executed'], ['revalued', 'Revalued proxy']]),
    select('gammaOptionTypes', 'Options', [['total', 'Total'], ['call', 'Calls'], ['put', 'Puts']]),
    select('gammaStrikeScope', 'Scope', [['dynamic', 'Dynamic ATM'], ['anchored', 'Anchored ATM'], ['explicit', 'Explicit strikes']]),
    input('gammaWidth', '± strikes', '1 / 2 / 3 / 5 / custom', 'number'),
    input('gammaStrikes', 'Strikes', '7740,7750 or 7700:7800'),
    input('gammaAnchorAt', 'ATM anchor', 'ISO timestamp with Z or UTC offset; captures ATM and strike ladder'),
    select('gammaWindow', 'Window', [['session', 'Session'], ['rolling', 'Rolling'], ['anchored', 'Anchored cumulative']]),
    input('gammaMinutes', 'Minutes', '1 / 5 / 15 / 30 / custom', 'number'),
    input('gammaStart', 'Time anchor', 'ISO timestamp with Z or UTC offset'),
    select('gammaQuality', 'Classification', [['all', 'All signed gamma'], ['reliable', 'Reliable only']]),
    input('gammaQuoteMaxAgeSeconds', 'Quote age (s)', 'Maximum reliable quote age', 'number'),
    showAnalysis ? select('gammaAnalysis', 'Analysis', [['iv', 'IV Confirmation'], ['relative', 'Relative Convexity Demand']]) : '',
    `<label class="widget-control widget-control-checkbox"><input type="checkbox" ${attrs('gammaDebug')} ${c.gammaDebug === true ? 'checked' : ''}/><span>debug</span></label>`
  ].join('');
}
