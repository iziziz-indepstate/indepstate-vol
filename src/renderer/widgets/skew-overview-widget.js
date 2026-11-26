import { calculateSkewOverview, normalizeSkewOverviewConfig, skewOverviewDefaultConfig, skewOverviewWindow } from '../../shared/skew-overview.mjs';
import { ensureChartJsRuntime } from './widget-renderers.js';

const states = new WeakMap();
const PANELS = [['smile', 'Smile'], ['term', 'Term'], ['table', 'Table']];
const RANGES = [['auto', 'Auto'], ['5', '±5%'], ['10', '±10%'], ['20', '±20%'], ['all', 'All']];
const METRICS = [
  ['atmIV', 'ATM IV', ''], ['skew25', '25Δ Skew', 'vol pts'], ['butterfly25', '25Δ Butterfly', 'vol pts'],
  ['skew10', '10Δ Skew', 'vol pts'], ['skewSlope', 'Skew Slope', 'vol pts / 1% strike'],
  ['termSlope', 'Term Slope', 'vol pts / 30 days']
];
const COLORS = { put: '#f17b95', call: '#4dd9a4', atm: '#f2c56e', spot: '#a9b4c7', grid: '#ffffff14' };
const strikeText = new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 });
const date = (value) => value ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}` : '';
const format = (value, digits = 2) => Number.isFinite(value) ? value.toFixed(digits) : 'N/A';
const iv = (value) => Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : 'N/A';
const xy = (x, value) => ({ x, y: value == null ? null : value * 100 });

export function buildSmileChart(model, { min, max }) {
  const { spot, atmIV, wing25, quotes } = model;
  const datasets = [];
  const markers = [];
  const otmLines = {};
  for (const type of ['put', 'call']) {
    const side = quotes.filter((q) => q.type === type);
    const label = type === 'put' ? 'Put' : 'Call';
    const color = COLORS[type];
    for (const moneyness of ['otm', 'itm']) {
      const otm = moneyness === 'otm';
      const data = side.filter((q) => q.moneyness === moneyness || q.moneyness === 'atm'
        || (otm && q.moneyness == null))
        .map((q) => ({ ...xy(q.strike, q.valid ? q.iv : null), quote: q }));
      if (!data.some((point) => point.y != null)) continue;
      const dataset = {
        label: `${spot == null ? '' : otm ? 'OTM ' : 'ITM '}${label}s`, data, borderColor: otm ? color : `${color}55`,
        pointBackgroundColor: color, borderWidth: otm ? 2 : 1, order: otm ? 1 : 2,
        pointRadius: otm ? ({ raw }) => raw?.quote ? 1.5 : 0 : 1,
        pointHitRadius: ({ raw }) => raw?.quote ? 8 : 0
      };
      if (otm) otmLines[type] = data;
      datasets.push(dataset);
    }
    const bid = side.filter((q) => q.moneyness === 'otm' || q.moneyness === 'atm')
      .map((q) => xy(q.strike, q.valid ? q.bidIV : null));
    if (atmIV != null && bid.some((point) => point.y != null)) {
      datasets.push({
        label: `${label} bid IV`, data: bid, order: 3, borderWidth: 0,
        pointRadius: 0, pointHitRadius: 0, pointHoverRadius: 0, showInLegend: false,
        fill: { target: { value: atmIV * 100 }, above: '#f17b9528', below: '#4dd9a426' }
      });
    }
    const wing = wing25[type];
    if (wing.strike != null && (min == null || wing.strike >= min) && (max == null || wing.strike <= max)) {
      markers.push({ ...xy(wing.strike, wing.iv), label: `25Δ ${label}`, color });
      datasets.push({
        label: `25Δ ${label}`, data: [{ ...xy(wing.strike, wing.iv), wing }], order: 0, showInLegend: false,
        borderColor: color, pointBackgroundColor: '#151a23', pointBorderWidth: 2, pointRadius: 4, clip: 5
      });
    }
  }
  let atmJoin = null;
  const putEdge = otmLines.put?.at(-1);
  const callEdge = otmLines.call?.[0];
  if (spot != null && atmIV != null && putEdge?.y != null && callEdge?.y != null) {
    atmJoin = xy(spot, atmIV);
    otmLines.put.push(atmJoin);
    otmLines.call.unshift(atmJoin);
  }
  return {
    datasets, xTitle: 'Strike', min, max, spot, atmIV, atmJoin, markers,
    shaded: datasets.some((dataset) => Boolean(dataset.fill))
  };
}

function termChart(term, expiration) {
  const selected = term.find((row) => row.expiration === expiration);
  return {
    xTitle: 'Calendar DTE', selectedDte: selected?.dte, markers: [],
    datasets: [['atmIV', 'ATM IV', COLORS.atm], ['put25IV', 'Put −25Δ', COLORS.put], ['call25IV', 'Call +25Δ', COLORS.call]]
      .map(([key, label, color]) => ({
        label, borderColor: color, pointBackgroundColor: color, borderWidth: 2,
        pointRadius: ({ raw }) => raw?.expiration === expiration ? 5 : 2.5,
        data: term.map((row) => ({ ...xy(row.dte, row[key]), expiration: row.expiration }))
      }))
  };
}

function chartReferences(state) {
  return {
    id: 'skewOverviewReferences',
    beforeDatasetsDraw(chart) {
      const { spot, atmIV, selectedDte } = state.chartModel;
      const { ctx, chartArea: area, scales } = chart;
      const xValue = spot ?? selectedDte;
      const x = xValue == null ? NaN : scales.x.getPixelForValue(xValue);
      const y = atmIV == null ? NaN : scales.y.getPixelForValue(atmIV * 100);
      ctx.save();
      ctx.font = '10px sans-serif';
      ctx.setLineDash([4, 4]);
      if (x >= area.left && x <= area.right) {
        const label = spot == null ? `Selected · ${selectedDte} DTE` : `Spot ${strikeText.format(spot)}`;
        ctx.strokeStyle = ctx.fillStyle = COLORS.spot;
        ctx.beginPath();
        ctx.moveTo(x, area.top);
        ctx.lineTo(x, area.bottom);
        ctx.stroke();
        ctx.fillText(label, Math.max(area.left, Math.min(x + 5, area.right - ctx.measureText(label).width)), area.top + 12);
      }
      if (y >= area.top && y <= area.bottom) {
        ctx.strokeStyle = ctx.fillStyle = COLORS.atm;
        ctx.beginPath();
        ctx.moveTo(area.left, y);
        ctx.lineTo(area.right, y);
        ctx.stroke();
        ctx.textAlign = 'right';
        ctx.fillText(`ATM ${iv(atmIV)}`, area.right - 3, Math.max(area.top + 10, y - 4));
      }
      ctx.restore();
    },
    afterDatasetsDraw(chart) {
      const { ctx, chartArea: area, scales } = chart;
      const { atmJoin, markers } = state.chartModel;
      ctx.save();
      ctx.font = '10px sans-serif';
      for (const marker of markers) {
        const x = scales.x.getPixelForValue(marker.x);
        const y = scales.y.getPixelForValue(marker.y);
        if (y < area.top || y > area.bottom) continue;
        const left = Math.max(area.left, Math.min(x + 6, area.right - ctx.measureText(marker.label).width));
        ctx.fillStyle = marker.color;
        ctx.fillText(marker.label, left, Math.max(area.top + 10, y - 5));
      }
      if (atmJoin) {
        const x = scales.x.getPixelForValue(atmJoin.x);
        const y = scales.y.getPixelForValue(atmJoin.y);
        if (x >= area.left && x <= area.right && y >= area.top && y <= area.bottom) {
          ctx.fillStyle = COLORS.atm;
          ctx.beginPath();
          ctx.arc(x, y, 3.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();
    }
  };
}

function tooltipLines({ dataset, raw }) {
  if (raw.quote) {
    const q = raw.quote;
    return [
      `${q.type === 'put' ? 'Put' : 'Call'} · Strike ${strikeText.format(q.strike)}`,
      `Δ ${format(q.delta, 4)} · IV ${iv(q.iv)} · Bid IV ${iv(q.bidIV)}`,
      `Bid ${format(q.bid)} · Ask ${format(q.ask)}`
    ];
  }
  if (raw.wing) {
    return [`${dataset.label} · Strike ${strikeText.format(raw.x)} · IV ${iv(raw.wing.iv)}`,
      ...raw.wing.contracts.map((q) => `Strike ${strikeText.format(q.strike)} · Δ ${format(q.delta, 4)} · IV ${iv(q.iv)}`)];
  }
  return `${date(raw.expiration)} · ${dataset.label} ${format(raw.y)}%`;
}

function chartOptions(model) {
  const atmIVPercent = model.atmIV == null ? undefined : model.atmIV * 100;
  return {
    responsive: true, maintainAspectRatio: false, animation: false, parsing: false, spanGaps: false,
    elements: { point: { hitRadius: 8 } },
    interaction: { mode: 'nearest', intersect: true },
    scales: {
      x: { type: 'linear', min: model.min, max: model.max, suggestedMin: model.spot ?? model.selectedDte,
        suggestedMax: model.spot ?? model.selectedDte, title: { display: true, text: model.xTitle, color: COLORS.spot },
        grid: { display: false }, ticks: { color: COLORS.spot, precision: model.xTitle === 'Calendar DTE' ? 0 : undefined } },
      y: { type: 'linear', suggestedMin: atmIVPercent, suggestedMax: atmIVPercent, grace: '8%',
        grid: { color: COLORS.grid }, ticks: { color: COLORS.spot, callback: (value) => `${value}%` } }
    },
    plugins: {
      filler: { drawTime: 'beforeDatasetsDraw' },
      legend: { position: 'bottom', onClick: () => {}, labels: { color: COLORS.spot, boxWidth: 12, boxHeight: 3,
        filter: (item, data) => data.datasets[item.datasetIndex].showInLegend !== false } },
      tooltip: { filter: ({ dataset, raw }) => Boolean(raw?.wing || raw?.expiration
          || (raw?.quote && (raw.quote.moneyness !== 'atm' || dataset.order !== 2))),
        callbacks: { title: () => '', label: tooltipLines } }
    }
  };
}

function initialize(container, onChange) {
  container.innerHTML = `
    <div class="iv-skew-controls">
      <label>Expiration <select data-skew-control="expiration"><option value="auto">Auto</option></select></label>
      <div class="iv-skew-segments" role="group" aria-label="Strike range" data-skew-ranges>
        ${RANGES.map(([value, label]) => `<button type="button" class="btn btn-compact" data-skew-control="range" value="${value}">${label}</button>`).join('')}
      </div>
      <div class="iv-skew-segments" role="group" aria-label="Panel">
        ${PANELS.map(([value, label]) => `<button type="button" class="btn btn-compact" data-skew-control="panel" value="${value}">${label}</button>`).join('')}
      </div>
    </div>
    <div class="iv-skew-summary" data-skew-summary></div>
    <dl class="iv-skew-metrics">${METRICS.map(([key, label]) => `<div><dt>${label}</dt><dd data-skew-metric="${key}"></dd><dd class="iv-skew-unit" data-skew-unit="${key}"></dd></div>`).join('')}</dl>
    <div class="iv-skew-status" data-skew-status role="status" hidden></div>
    <div class="iv-skew-plot" data-skew-plot hidden><canvas role="img"></canvas></div>
    <div class="iv-skew-shade-key" data-skew-shade-key hidden>
      <span>Bid IV above ATM</span><span>Bid IV below ATM</span>
    </div>
    <div class="iv-skew-table spread-opt-table-wrap" data-skew-table hidden><table class="spread-opt-table">
      <thead><tr><th scope="col">Strike</th><th scope="col">Side</th><th scope="col">Delta</th><th scope="col">IV</th>
        <th scope="col">Bid IV</th><th scope="col">Bid</th><th scope="col">Ask</th></tr></thead><tbody></tbody>
    </table></div>`;
  const controls = [...container.querySelectorAll('[data-skew-control]')];
  controls.forEach((control) => control.addEventListener(control.tagName === 'SELECT' ? 'change' : 'click',
    () => onChange(control.dataset.skewControl, control.value)));
  return {
    controls, select: controls[0], summary: container.querySelector('[data-skew-summary]'),
    ranges: container.querySelector('[data-skew-ranges]'), status: container.querySelector('[data-skew-status]'),
    plot: container.querySelector('[data-skew-plot]'), shadeKey: container.querySelector('[data-skew-shade-key]'),
    canvas: container.querySelector('canvas'), table: container.querySelector('[data-skew-table]'),
    tbody: container.querySelector('tbody'), metrics: METRICS.map(([key, , unit]) => ({
      key, unit, valueNode: container.querySelector(`[data-skew-metric="${key}"]`),
      unitNode: container.querySelector(`[data-skew-unit="${key}"]`)
    }))
  };
}

function renderHeader(state, config, overview) {
  const dates = [...new Set([...overview.term.map(({ expiration }) => expiration),
    ...(config.expiration === 'auto' ? [] : [config.expiration])])].sort();
  const key = dates.join(',');
  if (state.expirationOptions !== key) {
    state.select.innerHTML = '<option value="auto">Auto</option>' +
      dates.map((expiration) => `<option value="${expiration}">${date(expiration)}</option>`).join('');
    state.expirationOptions = key;
  }
  state.select.value = config.expiration;
  state.ranges.hidden = config.panel === 'term';
  for (const button of state.controls.slice(1)) {
    button.setAttribute('aria-pressed', String(config[button.dataset.skewControl] === button.value));
  }
  state.summary.textContent = [date(overview.expiration),
    overview.dte == null ? '' : `${overview.dte} DTE`,
    overview.expiration && overview.status !== 'waiting_for_snapshot' ? `${overview.contractCount} contracts` : ''].filter(Boolean).join(' · ');
  for (const { key, unit, valueNode, unitNode } of state.metrics) {
    const value = overview.metrics?.[key];
    valueNode.textContent = key === 'atmIV' ? iv(value)
      : Number.isFinite(value) ? `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(2)}` : 'N/A';
    unitNode.textContent = key === 'atmIV' && overview.metrics?.atmStrike != null
      ? `Strike ${strikeText.format(overview.metrics.atmStrike)}` : unit;
  }
}

function destroyChart(state) {
  state.chart?.destroy();
  state.chart = null;
  state.chartPanel = null;
}

function setStatus(state, message) {
  state.status.textContent = message;
  state.status.hidden = !message;
}

export const skewOverviewWidget = {
  type: 'skew-overview', defaultTitle: 'Skew. Overview', providerKey: 'tradingview',
  mode: 'table', gridSpan: 6, heightUnits: 2, defaultConfig: skewOverviewDefaultConfig,
  destroy(container) {
    const state = states.get(container);
    if (state) destroyChart(state);
    states.delete(container);
  },
  async render({ container, snapshot, widget, widgetData, onConfigChange, isCurrent = () => true }) {
    let state = states.get(container);
    if (!state) {
      state = initialize(container, (name, value) => {
        if (!state.isCurrent() || state.config[name] === value) return;
        widget.config = { ...state.config, [name]: value };
        state.onConfigChange?.();
      });
      states.set(container, state);
    }
    const config = normalizeSkewOverviewConfig(widget.config);
    const current = () => states.get(container) === state && isCurrent();
    Object.assign(state, { config, isCurrent: current, onConfigChange });
    if (!state.overview || state.snapshot !== snapshot || state.requestedExpiration !== config.expiration) {
      state.overview = calculateSkewOverview(snapshot, config.expiration);
      state.snapshot = snapshot;
      state.requestedExpiration = config.expiration;
    }
    const overview = state.overview;
    renderHeader(state, config, overview);
    widgetData?.publish?.({ type: skewOverviewWidget.type, title: widget.title || skewOverviewWidget.defaultTitle, config, ...overview });

    const strikeWindow = skewOverviewWindow(overview.smile, config.range);
    const showTable = config.panel === 'table' && Boolean(overview.smile);
    state.table.hidden = !showTable;
    if (showTable) {
      state.tbody.innerHTML = strikeWindow.quotes.map((q) => `<tr><td>${strikeText.format(q.strike)}</td>
        <td class="iv-skew-${q.type}">${q.type === 'put' ? 'Put' : 'Call'}</td><td>${format(q.delta, 4)}</td>
        <td>${iv(q.iv)}</td><td>${iv(q.bidIV)}</td><td>${format(q.bid)}</td><td>${format(q.ask)}</td></tr>`).join('');
    }
    const model = config.panel === 'term' ? termChart(overview.term, overview.expiration)
      : config.panel === 'smile' && overview.smile ? buildSmileChart(overview.smile, strikeWindow) : null;
    const hasPlot = model?.datasets.some((dataset) => dataset.order !== 3 &&
      dataset.data.some(({ x, y }) => y != null && (model.min == null || x >= model.min) && (model.max == null || x <= model.max)));
    let status = '';
    if (overview.status === 'waiting_for_snapshot') {
      status = 'Waiting for a full TradingView snapshot.';
    } else if (overview.status === 'missing_chain') {
      status = overview.expiration ? 'No contracts for the selected expiration.' : 'No contracts in the TradingView expiration range.';
    } else if (config.panel === 'table' && !strikeWindow.quotes.length) {
      status = 'No strikes in this range.';
    } else if (config.panel !== 'table' && !hasPlot) {
      status = config.panel === 'term' ? 'No valid IV across expirations.' : 'No valid IV in this range.';
    }
    setStatus(state, status);
    state.plot.hidden = !hasPlot;
    state.shadeKey.hidden = !(hasPlot && model.shaded);
    if (state.chartPanel !== config.panel || !hasPlot) destroyChart(state);
    if (!hasPlot) return;

    state.canvas.setAttribute('aria-label', config.panel === 'term' ? 'Implied volatility by days to expiration' : 'Implied volatility by strike');
    state.chartModel = model;
    const options = chartOptions(model);
    if (state.chart) {
      state.chart.data.datasets = model.datasets;
      state.chart.options = options;
      state.chart.update('none');
      return;
    }
    try {
      const Chart = await ensureChartJsRuntime();
      if (!current()) return;
      state.chart = new Chart(state.canvas, { type: 'line', data: { datasets: model.datasets }, options, plugins: [chartReferences(state)] });
      state.chartPanel = config.panel;
    } catch (error) {
      if (current()) setStatus(state, `Could not render chart. ${error.message}`);
    }
  }
};
