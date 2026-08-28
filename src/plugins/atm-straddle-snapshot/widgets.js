import { ensureUPlotRuntime } from '../../renderer/widgets/widget-renderers.js';

const TENOR_OPTIONS = ['0DTE', '1D', '1W', '2W', '1M', '2M', '3M', '6M'];
const SERIES_COLORS = ['#7aa2ff', '#22c55e', '#f97316', '#d946ef', '#06b6d4', '#eab308', '#fb7185'];
const chartInstances = new WeakMap();

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
  return Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : 'n/a';
}

function normalizeTime(value, fallback = '16:45') {
  const raw = String(value || '').trim();
  const match = raw.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!match) return fallback;
  const hour = Math.min(23, Math.max(0, Number(match[1])));
  const minute = Math.min(59, Math.max(0, Number(match[2])));
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function normalizeOptionalTime(value) {
  const raw = String(value || '').trim();
  return raw ? normalizeTime(raw, '') : '';
}

function normalizeDate(value) {
  const raw = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : '';
}

function localMinute(value) {
  const dt = new Date(value || 0);
  if (Number.isNaN(dt.getTime())) return '';
  return `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
}

export function normalizeDailyLines(config = {}) {
  const lines = Array.isArray(config.lines) ? config.lines : [];
  const sourceLines = lines.length
    ? lines
    : [{ tenor: config.tenor || '0DTE', time: config.time || '16:45' }];
  return sourceLines.map((line) => ({
    tenor: String(line?.tenor || '0DTE').trim() || '0DTE',
    time: normalizeTime(line?.time)
  }));
}

function pointMeta(document, point) {
  return {
    date: document.date,
    time: point.time,
    localMinute: localMinute(point.time),
    atmStrike: point.atmStrike,
    spot: point.spot,
    straddlePts: point.straddlePts,
    sourceFile: document.source?.filename || null
  };
}

export function buildDailyPriceSeries(documents = [], config = {}) {
  const labels = [];
  const labelSet = new Set();
  const lines = normalizeDailyLines(config);
  const datasets = lines.map((line, lineIdx) => {
    const points = [];

    for (const document of Array.isArray(documents) ? documents : []) {
      if (String(document?.identity?.tenor || '') !== line.tenor) continue;
      const match = (Array.isArray(document?.points) ? document.points : [])
        .find((point) => localMinute(point?.time) === line.time);
      if (!match) continue;
      if (!labelSet.has(document.date)) {
        labelSet.add(document.date);
        labels.push(document.date);
      }
      points.push({
        x: document.date,
        y: Number(match.straddlePts),
        meta: pointMeta(document, match)
      });
    }

    const pointByDate = new Map(points.map((point) => [point.x, point]));
    return {
      label: `${line.tenor} @ ${line.time}`,
      _pointByDate: pointByDate,
      borderColor: SERIES_COLORS[lineIdx % SERIES_COLORS.length],
      pointRadius: 3,
      pointHitRadius: 8,
      pointHoverRadius: 4
    };
  });

  labels.sort();

  return {
    title: 'Straddle Daily Price',
    labels,
    datasets: datasets.map((dataset) => ({
      label: dataset.label,
      data: labels.map((label) => dataset._pointByDate.get(label)?.y ?? null),
      pointMeta: labels.map((label) => dataset._pointByDate.get(label)?.meta ?? null),
      borderColor: dataset.borderColor,
      pointRadius: dataset.pointRadius,
      pointHitRadius: dataset.pointHitRadius,
      pointHoverRadius: dataset.pointHoverRadius
    }))
  };
}

export function buildDynamicsSeries(documents = [], config = {}) {
  const startTime = normalizeOptionalTime(config.startTime);
  const endTime = normalizeOptionalTime(config.endTime);
  const labels = [];
  const labelSet = new Set();
  const datasets = [];

  for (const document of Array.isArray(documents) ? documents : []) {
    const points = (Array.isArray(document?.points) ? document.points : [])
      .map((point) => ({
        label: localMinute(point?.time),
        value: Number(point?.straddlePts),
        meta: pointMeta(document, point)
      }))
      .filter((point) => point.label
        && Number.isFinite(point.value)
        && (!startTime || point.label >= startTime)
        && (!endTime || point.label <= endTime));
    points.forEach((point) => {
      if (!labelSet.has(point.label)) {
        labelSet.add(point.label);
        labels.push(point.label);
      }
    });
    const valuesByLabel = new Map(points.map((point) => [point.label, point]));
    datasets.push({
      label: document.date,
      data: labels.map((label) => valuesByLabel.get(label)?.value ?? null),
      pointMeta: labels.map((label) => valuesByLabel.get(label)?.meta ?? null),
      borderColor: SERIES_COLORS[datasets.length % SERIES_COLORS.length],
      pointRadius: 0,
      pointHitRadius: 8,
      pointHoverRadius: 3
    });
  }

  labels.sort();
  return {
    title: 'Straddle Dynamics',
    labels,
    datasets: datasets.map((dataset) => {
      const valuesByMeta = new Map((dataset.pointMeta || [])
        .filter(Boolean)
        .map((meta) => [meta.localMinute, meta]));
      return {
        ...dataset,
        data: labels.map((label) => valuesByMeta.get(label)?.straddlePts ?? null),
        pointMeta: labels.map((label) => valuesByMeta.get(label) ?? null)
      };
    })
  };
}

function controlsMarkup(config, mode) {
  if (mode === 'daily') {
    const lines = normalizeDailyLines(config);
    const rows = lines.map((line, idx) => `<div class="straddle-snapshot-line">
      <label>Tenor
        <select data-straddle-snapshot-line-param="tenor" data-straddle-snapshot-line-index="${idx}">
          ${TENOR_OPTIONS.map((option) => `<option value="${esc(option)}" ${option === line.tenor ? 'selected' : ''}>${esc(option)}</option>`).join('')}
        </select>
      </label>
      <label>Time
        <input data-straddle-snapshot-line-param="time" data-straddle-snapshot-line-index="${idx}" type="text" value="${esc(line.time)}" placeholder="16:45" />
      </label>
      <button type="button" class="icon-btn straddle-snapshot-line-remove" data-straddle-snapshot-line-remove="${idx}" title="Remove line" aria-label="Remove line">x</button>
    </div>`).join('');
    return `<details class="straddle-snapshot-controls straddle-snapshot-settings">
      <summary>Lines</summary>
      <div class="straddle-snapshot-lines">${rows}</div>
      <button type="button" class="secondary-btn straddle-snapshot-line-add" data-straddle-snapshot-line-add>Add line</button>
    </details>`;
  }

  const tenor = String(config.tenor || '0DTE');
  const tenorSelect = `<label>Tenor
    <select data-straddle-snapshot-param="tenor">
      ${TENOR_OPTIONS.map((option) => `<option value="${esc(option)}" ${option === tenor ? 'selected' : ''}>${esc(option)}</option>`).join('')}
    </select>
  </label>`;
  const rangeControls = mode === 'dynamics'
    ? `<label>From <input data-straddle-snapshot-param="startDate" type="date" value="${esc(normalizeDate(config.startDate))}" /></label>
       <label>To <input data-straddle-snapshot-param="endDate" type="date" value="${esc(normalizeDate(config.endDate))}" /></label>
       <label class="straddle-snapshot-time-label">Start time <input data-straddle-snapshot-param="startTime" type="text" value="${esc(normalizeOptionalTime(config.startTime))}" placeholder="09:30" /></label>
       <label class="straddle-snapshot-time-label">End time <input data-straddle-snapshot-param="endTime" type="text" value="${esc(normalizeOptionalTime(config.endTime))}" placeholder="16:45" /></label>`
    : '';
  return `<div class="straddle-snapshot-controls">${tenorSelect}${rangeControls}</div>`;
}

function bindControls(container, widget, onConfigChange) {
  container.querySelectorAll('[data-straddle-snapshot-param]').forEach((control) => {
    control.addEventListener('change', (evt) => {
      const name = evt.target.dataset.straddleSnapshotParam;
      if (writeSnapshotWidgetConfigValue(widget, name, evt.target.value)) onConfigChange?.();
    });
  });
  container.querySelectorAll('[data-straddle-snapshot-line-param]').forEach((control) => {
    control.addEventListener('change', (evt) => {
      const index = Number(evt.target.dataset.straddleSnapshotLineIndex);
      const name = evt.target.dataset.straddleSnapshotLineParam;
      if (writeSnapshotWidgetLineConfigValue(widget, index, name, evt.target.value)) onConfigChange?.();
    });
  });
  container.querySelector('[data-straddle-snapshot-line-add]')?.addEventListener('click', () => {
    if (addSnapshotWidgetLine(widget)) onConfigChange?.();
  });
  container.querySelectorAll('[data-straddle-snapshot-line-remove]').forEach((button) => {
    button.addEventListener('click', (evt) => {
      const index = Number(evt.currentTarget.dataset.straddleSnapshotLineRemove);
      if (removeSnapshotWidgetLine(widget, index)) onConfigChange?.();
    });
  });
}

export function writeSnapshotWidgetConfigValue(widget, name, value) {
  if (!widget || !['tenor', 'time', 'startDate', 'endDate', 'startTime', 'endTime', 'settingsCollapsed'].includes(name)) return false;
  widget.config ||= {};
  if (name === 'time') {
    widget.config[name] = normalizeTime(value);
  } else if (name === 'startTime' || name === 'endTime') {
    widget.config[name] = normalizeOptionalTime(value);
  } else if (name === 'startDate' || name === 'endDate') {
    widget.config[name] = normalizeDate(value);
  } else if (name === 'settingsCollapsed') {
    widget.config[name] = value === true || value === 'true';
  } else {
    widget.config[name] = String(value || '0DTE').trim() || '0DTE';
  }
  return true;
}

export function writeSnapshotWidgetLineConfigValue(widget, index, name, value) {
  if (!widget || !Number.isInteger(index) || !['tenor', 'time'].includes(name)) return false;
  widget.config ||= {};
  widget.config.lines = normalizeDailyLines(widget.config);
  if (!widget.config.lines[index]) return false;
  widget.config.lines[index] = {
    ...widget.config.lines[index],
    [name]: name === 'time'
      ? normalizeTime(value)
      : (String(value || '0DTE').trim() || '0DTE')
  };
  delete widget.config.tenor;
  delete widget.config.time;
  return true;
}

export function addSnapshotWidgetLine(widget) {
  if (!widget) return false;
  widget.config ||= {};
  const lines = normalizeDailyLines(widget.config);
  const lastLine = lines[lines.length - 1] || { tenor: '0DTE', time: '16:45' };
  widget.config.lines = [...lines, { ...lastLine }];
  delete widget.config.tenor;
  delete widget.config.time;
  return true;
}

export function removeSnapshotWidgetLine(widget, index) {
  if (!widget || !Number.isInteger(index)) return false;
  widget.config ||= {};
  const lines = normalizeDailyLines(widget.config);
  if (!lines[index] || lines.length <= 1) return false;
  widget.config.lines = lines.filter((_, lineIdx) => lineIdx !== index);
  delete widget.config.tenor;
  delete widget.config.time;
  return true;
}

function chartTooltipPlugin(host, mode = 'daily') {
  return {
    hooks: {
      init: (uplot) => {
        const tooltip = document.createElement('div');
        tooltip.className = 'straddle-snapshot-tooltip';
        tooltip.style.display = 'none';
        host.appendChild(tooltip);
        let showTimer = null;
        let lastHover = null;

        const hideTooltip = () => {
          if (showTimer) {
            clearTimeout(showTimer);
            showTimer = null;
          }
          tooltip.style.display = 'none';
          lastHover = null;
        };

        const showTooltip = () => {
          showTimer = null;
          if (!lastHover?.meta && !lastHover?.rows?.length) return;
          const { meta, rows, left, top, width } = lastHover;
          tooltip.innerHTML = mode === 'dynamics'
            ? rows.map((row) => `<span>${esc(row.date)} - ${esc(row.localMinute)} - ${fmt(row.straddlePts)} pts</span>`).join('')
            : `
              <strong>${esc(meta.date)} ${esc(meta.localMinute)}</strong>
              <span>Straddle ${fmt(meta.straddlePts)} pts</span>
              <span>ATM ${fmt(meta.atmStrike, 0)} | Spot ${fmt(meta.spot, 2)}</span>
              <span>${esc(meta.sourceFile || '')}</span>
            `;
          tooltip.style.left = `${Math.min(Math.max(4, width - 220), Math.max(4, left + 12))}px`;
          tooltip.style.top = `${Math.max(4, top - 8)}px`;
          tooltip.style.display = 'flex';
        };

        const scheduleTooltip = (evt) => {
          const rect = uplot.over.getBoundingClientRect();
          const left = evt.clientX - rect.left;
          const top = evt.clientY - rect.top;
          if (left < 0 || top < 0 || left > rect.width || top > rect.height) {
            hideTooltip();
            return;
          }
          const idx = uplot.posToIdx(left);
          const rows = uplot.series
            .map((series, seriesIdx) => ({ series, seriesIdx }))
            .filter((item) => item.seriesIdx > 0)
            .map((item) => item.series?._pointMeta?.[idx])
            .filter((metaItem) => metaItem && Number.isFinite(Number(metaItem.straddlePts)))
            .sort((a, b) => Number(b.straddlePts) - Number(a.straddlePts));
          if (mode === 'dynamics') {
            if (!rows.length) {
              hideTooltip();
              return;
            }
            lastHover = {
              rows,
              left,
              top,
              width: rect.width
            };
            if (tooltip.style.display !== 'none') {
              showTooltip();
              return;
            }
            if (!showTimer) showTimer = setTimeout(showTooltip, 1000);
            return;
          }
          const datasetIdx = uplot.series
            .map((series, seriesIdx) => ({ series, seriesIdx }))
            .filter((item) => item.seriesIdx > 0)
            .find((item) => Number.isFinite(uplot.data[item.seriesIdx]?.[idx]))?.seriesIdx;
          const meta = datasetIdx ? uplot.series[datasetIdx]?._pointMeta?.[idx] : null;
          if (!meta) {
            hideTooltip();
            return;
          }
          lastHover = {
            meta,
            left,
            top,
            width: rect.width
          };
          if (tooltip.style.display !== 'none') {
            showTooltip();
            return;
          }
          if (!showTimer) showTimer = setTimeout(showTooltip, 1000);
        };

        const hideOnOutsidePointer = (evt) => {
          if (!host.contains(evt.target)) hideTooltip();
        };
        const hideOnOutsideMove = (evt) => {
          if (!host.contains(evt.target)) hideTooltip();
        };

        uplot.over.addEventListener('mousemove', scheduleTooltip);
        uplot.over.addEventListener('pointermove', scheduleTooltip);
        uplot.over.addEventListener('pointerleave', hideTooltip);
        uplot.over.addEventListener('mouseleave', hideTooltip);
        uplot.root.addEventListener('mouseleave', hideTooltip);
        uplot.root.addEventListener('pointerleave', hideTooltip);
        uplot.root.addEventListener('focusout', hideTooltip);
        host.addEventListener('mouseleave', hideTooltip);
        host.addEventListener('pointerleave', hideTooltip);
        globalThis.window?.addEventListener('blur', hideTooltip);
        document.addEventListener('pointerdown', hideOnOutsidePointer, true);
        document.addEventListener('pointermove', hideOnOutsideMove, true);
        document.addEventListener('scroll', hideTooltip, true);
        uplot._straddleSnapshotTooltipCleanup = () => {
          hideTooltip();
          uplot.over.removeEventListener('mousemove', scheduleTooltip);
          uplot.over.removeEventListener('pointermove', scheduleTooltip);
          uplot.over.removeEventListener('pointerleave', hideTooltip);
          uplot.over.removeEventListener('mouseleave', hideTooltip);
          uplot.root.removeEventListener('mouseleave', hideTooltip);
          uplot.root.removeEventListener('pointerleave', hideTooltip);
          uplot.root.removeEventListener('focusout', hideTooltip);
          host.removeEventListener('mouseleave', hideTooltip);
          host.removeEventListener('pointerleave', hideTooltip);
          globalThis.window?.removeEventListener('blur', hideTooltip);
          document.removeEventListener('pointerdown', hideOnOutsidePointer, true);
          document.removeEventListener('pointermove', hideOnOutsideMove, true);
          document.removeEventListener('scroll', hideTooltip, true);
        };
      },
      destroy: (uplot) => {
        uplot._straddleSnapshotTooltipCleanup?.();
        uplot._straddleSnapshotTooltipCleanup = null;
      }
    }
  };
}

function destroyChart(container) {
  chartInstances.get(container)?.destroy();
  chartInstances.delete(container);
}

async function renderChart(container, series, mode) {
  const host = container.querySelector('[data-straddle-snapshot-chart]');
  if (!host) return;
  destroyChart(container);
  const labels = Array.isArray(series?.labels) ? series.labels : [];
  const datasets = Array.isArray(series?.datasets) ? series.datasets : [];
  if (!labels.length || !datasets.some((dataset) => (dataset.data || []).some((value) => Number.isFinite(value)))) return;

  const UPlot = await ensureUPlotRuntime();
  const columns = [
    labels.map((_, idx) => idx),
    ...datasets.map((dataset) => labels.map((_, idx) => {
      const value = dataset.data?.[idx];
      return Number.isFinite(Number(value)) ? Number(value) : null;
    }))
  ];
  const hostRect = host.getBoundingClientRect();
  const height = Math.max(180, Math.round(host.clientHeight || hostRect.height || 240));
  const width = Math.max(180, Math.round(host.clientWidth || hostRect.width || 320));
  const chart = new UPlot({
    width,
    height,
    cursor: { show: true, drag: { x: false, y: false } },
    legend: { show: false },
    plugins: [chartTooltipPlugin(host, mode)],
    scales: { x: { time: false } },
    axes: [
      {
        values: (_, vals) => vals.map((x) => labels[x] ?? ''),
        stroke: 'rgba(234,234,240,0.66)',
        grid: { show: false },
        ticks: { show: false },
        size: 28
      },
      {
        stroke: 'rgba(234,234,240,0.66)',
        grid: { stroke: 'rgba(234,234,240,0.10)', width: 1 },
        size: 48
      }
    ],
    series: [
      {},
      ...datasets.map((dataset) => ({
        label: dataset.label,
        stroke: dataset.borderColor || '#7aa2ff',
        width: 2,
        points: { show: (dataset.pointRadius || 0) > 0, size: 5 },
        _pointMeta: dataset.pointMeta || []
      }))
    ]
  }, columns, host);
  chartInstances.set(container, chart);
}

async function loadDocuments(config) {
  const appBridge = globalThis.window?.appBridge;
  if (typeof appBridge?.loadAtmStraddleSnapshots !== 'function') {
    return {
      ok: false,
      documents: [],
      warnings: [{ message: 'ATM straddle snapshot loader is unavailable.' }]
    };
  }
  return appBridge.loadAtmStraddleSnapshots({
    tenor: config.tenor || '0DTE',
    startDate: config.startDate || '',
    endDate: config.endDate || ''
  });
}

async function loadDailyDocuments(config) {
  const lines = normalizeDailyLines(config);
  const appBridge = globalThis.window?.appBridge;
  if (typeof appBridge?.loadAtmStraddleSnapshots !== 'function') {
    return {
      ok: false,
      documents: [],
      warnings: [{ message: 'ATM straddle snapshot loader is unavailable.' }]
    };
  }
  const tenors = [...new Set(lines.map((line) => line.tenor))];
  const results = await Promise.all(tenors.map((tenor) => appBridge.loadAtmStraddleSnapshots({ tenor })));
  return {
    ok: results.every((result) => result?.ok !== false),
    documents: results.flatMap((result) => Array.isArray(result?.documents) ? result.documents : []),
    warnings: results.flatMap((result) => Array.isArray(result?.warnings) ? result.warnings : [])
  };
}

async function renderSnapshotChartWidget({ container, widget, widgetData, onConfigChange, mode }) {
  widget.config ||= {};
  const defaultConfig = mode === 'daily' ? straddleDailyPriceWidget.defaultConfig : straddleDynamicsWidget.defaultConfig;
  const config = { ...defaultConfig, ...widget.config };
  if (mode === 'daily') config.lines = normalizeDailyLines(config);
  config.startDate = normalizeDate(config.startDate);
  config.endDate = normalizeDate(config.endDate);
  config.startTime = normalizeOptionalTime(config.startTime);
  config.endTime = normalizeOptionalTime(config.endTime);
  container.innerHTML = `${controlsMarkup(config, mode)}<div class="straddle-snapshot-chart" data-straddle-snapshot-chart></div><div class="straddle-snapshot-status">Loading snapshots...</div>`;
  bindControls(container, widget, onConfigChange);

  const result = mode === 'daily' ? await loadDailyDocuments(config) : await loadDocuments(config);
  const documents = Array.isArray(result?.documents) ? result.documents : [];
  const series = mode === 'daily'
    ? buildDailyPriceSeries(documents, config)
    : buildDynamicsSeries(documents, config);
  widgetData?.publish?.({
    type: mode === 'daily' ? straddleDailyPriceWidget.type : straddleDynamicsWidget.type,
    status: result?.ok === false ? 'error' : 'ok',
    title: widget.title || (mode === 'daily' ? straddleDailyPriceWidget.defaultTitle : straddleDynamicsWidget.defaultTitle),
    config,
    documents: documents.length,
    warnings: Array.isArray(result?.warnings) ? result.warnings : [],
    series
  });
  const status = container.querySelector('.straddle-snapshot-status');
  const pointCount = series.datasets.reduce((acc, dataset) => acc + (dataset.data || []).filter((value) => Number.isFinite(value)).length, 0);
  if (!pointCount) {
    status.textContent = mode === 'daily'
      ? 'No snapshot points for configured lines.'
      : `No ${config.tenor} snapshot dynamics in range.`;
    return;
  }

  status.textContent = `${documents.length} files, ${pointCount} points${result?.warnings?.length ? `, ${result.warnings.length} warnings` : ''}`;
  await renderChart(container, series, mode);
}

export function destroyStraddleSnapshotWidget(container) {
  destroyChart(container);
}

export const straddleDailyPriceWidget = {
  type: 'straddle-daily-price',
  mode: 'table',
  gridSpan: 3,
  defaultTitle: 'Straddle Daily Price',
  defaultConfig: {
    lines: [{ tenor: '0DTE', time: '16:45' }]
  },
  render: (context) => renderSnapshotChartWidget({ ...context, mode: 'daily' }),
  destroy: destroyStraddleSnapshotWidget
};

export const straddleDynamicsWidget = {
  type: 'straddle-dynamics',
  mode: 'table',
  gridSpan: 3,
  defaultTitle: 'Straddle Dynamics',
  defaultConfig: {
    tenor: '0DTE',
    startDate: '',
    endDate: '',
    startTime: '',
    endTime: ''
  },
  render: (context) => renderSnapshotChartWidget({ ...context, mode: 'dynamics' }),
  destroy: destroyStraddleSnapshotWidget
};

export const atmStraddleSnapshotWidgets = [
  straddleDailyPriceWidget,
  straddleDynamicsWidget
];
