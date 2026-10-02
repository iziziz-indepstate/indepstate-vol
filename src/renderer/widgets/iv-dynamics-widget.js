import { buildIVDynamicsMatrix } from '../../shared/iv-dynamics-calculations.mjs';

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[ch]));
}

function fmtPct(value, digits = 1) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(digits)}%` : 'n/a';
}

function fmtVolPts(value, digits = 2) {
  return Number.isFinite(value) ? `${value >= 0 ? '+' : ''}${(value * 100).toFixed(digits)} vol pts` : 'n/a';
}

function fmtNum(value, digits = 2) {
  return Number.isFinite(value) ? Number(value).toFixed(digits) : 'n/a';
}

function fmtDelta(value) {
  if (value === 'ATM') return 'ATM';
  return Number.isFinite(value) ? `${Math.round(Math.abs(value) * 100)}D` : 'n/a';
}

function fmtTime(value) {
  const dt = new Date(value || 0);
  return Number.isNaN(dt.getTime()) ? String(value || '') : dt.toLocaleString();
}

function cellColor(delta) {
  if (!Number.isFinite(delta)) return 'rgba(255,255,255,0.055)';
  const magnitude = Math.min(1, Math.abs(delta) / 0.015);
  if (magnitude < 0.04) return 'rgba(148,163,184,0.30)';
  if (delta > 0) return `rgba(239, 68, 68, ${0.22 + magnitude * 0.68})`;
  return `rgba(34, 197, 94, ${0.20 + magnitude * 0.66})`;
}

function tooltipForCell(cell, mode) {
  const modeLabel = mode === 'iv' ? 'Absolute IV' : 'IV minus ATM';
  return [
    `${cell.label}`,
    `Time: ${fmtTime(cell.timestamp)}`,
    `Expiration: ${cell.expiration || 'n/a'}`,
    `Side: ${String(cell.side || '').toUpperCase() || 'n/a'}`,
    `Delta: ${fmtDelta(cell.delta)}`,
    `Strike: ${fmtNum(cell.matchedStrike, 0)}`,
    `Matched delta: ${fmtNum(cell.matchedDelta, 3)}`,
    `IV: ${fmtPct(cell.iv)}`,
    `ATM IV: ${fmtPct(cell.atmIV)}`,
    `IV minus ATM: ${fmtVolPts(cell.premium)}`,
    `${modeLabel}: ${mode === 'iv' ? fmtPct(cell.value) : fmtVolPts(cell.value)}`,
    `Vs previous: ${fmtVolPts(cell.comparisons?.previous)}`,
    `Vs ~15m: ${fmtVolPts(cell.comparisons?.m15)}`,
    `Vs ~60m: ${fmtVolPts(cell.comparisons?.m60)}`,
    `Vs session start: ${fmtVolPts(cell.comparisons?.session)}`,
    cell.warning ? `Warning: ${cell.warning}` : ''
  ].filter(Boolean).join('\n');
}

function renderControls(cfg) {
  return `
    <div class="iv-dynamics-controls">
      <label>Exp
        <input data-iv-dynamics-param="expiration" type="text" value="${esc(cfg.expiration || '')}" placeholder="primary / tomorrow" />
      </label>
      <label>Deltas
        <input data-iv-dynamics-param="deltas" type="text" value="${esc(cfg.deltas || '')}" placeholder="ATM,90,75,50,25,10,5" />
      </label>
      <label>Mode
        <select data-iv-dynamics-param="mode">
          <option value="premium" ${cfg.mode !== 'iv' ? 'selected' : ''}>IV minus ATM</option>
          <option value="iv" ${cfg.mode === 'iv' ? 'selected' : ''}>Absolute IV</option>
        </select>
      </label>
      <label>Columns
        <input data-iv-dynamics-param="maxColumns" type="number" min="1" max="1000" step="1" value="${esc(cfg.maxColumns || 120)}" />
      </label>
    </div>
  `;
}

function bindControls(container, widget, onConfigChange) {
  container.querySelectorAll('[data-iv-dynamics-param]').forEach((el) => {
    el.addEventListener('change', (evt) => {
      const name = evt.target.dataset.ivDynamicsParam;
      widget.config ||= {};
      if (name === 'maxColumns') {
        const parsed = Math.floor(Number(evt.target.value));
        widget.config[name] = Number.isFinite(parsed) ? Math.max(1, parsed) : 120;
      } else if (name === 'mode') {
        widget.config[name] = evt.target.value === 'iv' ? 'iv' : 'premium';
      } else {
        widget.config[name] = evt.target.value;
      }
      onConfigChange();
    });
  });
}

function renderHeatmap(matrix) {
  if (!matrix.columns.length) {
    return '<div class="iv-dynamics-empty">No option-chain history yet.</div>';
  }
  const columns = matrix.columns;
  const columnLabels = columns.map((column) => `<span>${esc(column.label)}</span>`).join('');
  const rows = matrix.rows.map((row, rowIdx) => {
    const cells = matrix.cells[rowIdx].map((cell) => {
      const color = cellColor(cell.comparisons?.previous);
      const valueLabel = matrix.mode === 'iv' ? fmtPct(cell.value) : fmtVolPts(cell.value);
      return `<button class="iv-dynamics-cell" type="button" title="${esc(tooltipForCell(cell, matrix.mode))}" style="--iv-cell-bg: ${color}" aria-label="${esc(`${row.label} ${valueLabel}`)}"></button>`;
    }).join('');
    return `
      <div class="iv-dynamics-row">
        <div class="iv-dynamics-row-label">${esc(row.label)}</div>
        <div class="iv-dynamics-cells" style="grid-template-columns: repeat(${columns.length}, var(--iv-dynamics-cell-size));">${cells}</div>
      </div>
    `;
  }).join('');

  return `
    <div class="iv-dynamics-shell">
      <div class="iv-dynamics-scroll" data-iv-dynamics-scroll>
        <div class="iv-dynamics-time-row">
          <div class="iv-dynamics-row-label"></div>
          <div class="iv-dynamics-column-labels" style="grid-template-columns: repeat(${columns.length}, var(--iv-dynamics-cell-size));">${columnLabels}</div>
        </div>
        ${rows}
      </div>
      <div class="iv-dynamics-footer">
        <span>${esc(matrix.mode === 'iv' ? 'Mode: Absolute IV' : 'Mode: IV minus ATM')}</span>
        <span>Expiration: ${esc(matrix.expiration || 'n/a')}</span>
        <span>Columns: ${matrix.columns.length}</span>
      </div>
      ${matrix.warnings.length ? `<div class="iv-dynamics-warning">${esc(matrix.warnings.slice(0, 3).join(' | '))}</div>` : ''}
    </div>
  `;
}

export const ivDynamicsWidget = {
  type: 'iv-dynamics',
  mode: 'table',
  wide: true,
  gridSpan: 6,
  requiresHistory: true,
  defaultTitle: 'IV Dynamics',
  defaultConfig: {
    expiration: '',
    deltas: 'ATM,90,75,50,25,10,5',
    mode: 'premium',
    maxColumns: 120
  },
  render: async ({ container, history, widget, widgetData, onConfigChange }) => {
    const cfg = { ...ivDynamicsWidget.defaultConfig, ...(widget.config || {}) };
    container.innerHTML = `${renderControls(cfg)}<div class="iv-dynamics-empty">Loading...</div>`;
    bindControls(container, widget, onConfigChange);

    try {
      const matrix = buildIVDynamicsMatrix(history, cfg);
      widgetData?.publish?.({
        type: ivDynamicsWidget.type,
        status: 'ok',
        title: widget.title || ivDynamicsWidget.defaultTitle,
        config: { ...cfg },
        expiration: matrix.expiration,
        mode: matrix.mode,
        rows: matrix.rows,
        columns: matrix.columns,
        cells: matrix.cells,
        warnings: matrix.warnings
      });
      container.innerHTML = `${renderControls(cfg)}${renderHeatmap(matrix)}`;
      bindControls(container, widget, onConfigChange);
      const scroller = container.querySelector('[data-iv-dynamics-scroll]');
      if (scroller) scroller.scrollLeft = scroller.scrollWidth;
    } catch (err) {
      widgetData?.publish?.({
        type: ivDynamicsWidget.type,
        status: 'error',
        title: widget.title || ivDynamicsWidget.defaultTitle,
        config: { ...cfg },
        error: err?.message || String(err)
      });
      container.innerHTML = `${renderControls(cfg)}<div class="iv-dynamics-warning">${esc(err?.message || err)}</div>`;
      bindControls(container, widget, onConfigChange);
    }
  }
};
