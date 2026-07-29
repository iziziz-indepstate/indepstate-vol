import { WIDGET_PARAM_NAMES } from './widget-params.js';
import { createStrikeClipboardChain } from './strike-clipboard-chain.js';

let chartJsLoadPromise = null;
let uPlotLoadPromise = null;
const strikeClipboardChain = createStrikeClipboardChain();

export function chartRuntimeForDefinition(definition) {
  return definition?.chartRuntime || 'chartjs';
}

export async function ensureChartJsRuntime() {
  if (window.Chart) return window.Chart;
  chartJsLoadPromise ||= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '../../node_modules/chart.js/dist/chart.umd.js';
    script.onload = () => (window.Chart ? resolve(window.Chart) : reject(new Error('Chart.js did not initialize')));
    script.onerror = () => reject(new Error('Unable to load Chart.js runtime'));
    document.head.appendChild(script);
  });
  return chartJsLoadPromise;
}

export async function ensureUPlotRuntime() {
  if (!document.querySelector('link[data-chart-runtime="uplot"]')) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '../../node_modules/uplot/dist/uPlot.min.css';
    link.dataset.chartRuntime = 'uplot';
    document.head.appendChild(link);
  }
  uPlotLoadPromise ||= import('../../../node_modules/uplot/dist/uPlot.esm.js');
  const mod = await uPlotLoadPromise;
  return mod.default || mod.uPlot || mod;
}

export function createWidgetCard(widget, definition) {
  const card = document.createElement('article');
  card.className = 'widget-card';
  if (widget.collapsed) card.classList.add('widget-card-collapsed');
  if (definition?.mode === 'table' && definition?.wide !== false) card.classList.add('widget-card-wide');
  if (Number.isInteger(definition?.gridSpan) && definition.gridSpan > 1) {
    card.dataset.gridSpan = String(definition.gridSpan);
  }
  card.draggable = true;
  card.dataset.widgetCardId = widget.id;

  const controlsConfig = definition?.controls || (definition.mode === 'snapshot-series'
    ? { strike: true, expiryStart: true, expiryEnd: true, strikeInputType: 'number' }
    : {});

  const strikeValueRaw = widget?.config?.baseStrike ?? definition?.defaultConfig?.baseStrike ?? 500;
  const strikeValue = controlsConfig.strikeInputType === 'number'
    ? Number(strikeValueRaw)
    : String(strikeValueRaw ?? '');
  const strikeInputType = controlsConfig.strikeInputType === 'text' ? 'text' : 'number';

  const expiryStartValue = String(widget?.config?.expiryStart ?? widget?.config?.expiry ?? definition?.defaultConfig?.expiryStart ?? '');
  const expiryEndValue = String(widget?.config?.expiryEnd ?? definition?.defaultConfig?.expiryEnd ?? '');
  const tailStepsValue = Number(widget?.config?.tailSteps ?? definition?.defaultConfig?.tailSteps ?? 3);
  const strikeRangeValue = String(widget?.config?.strikeRange ?? definition?.defaultConfig?.strikeRange ?? '');
  const optionTypeValue = String(widget?.config?.optionType ?? definition?.defaultConfig?.optionType ?? 'put');
  const targetDeltaValue = Number(widget?.config?.targetDelta ?? definition?.defaultConfig?.targetDelta ?? 0.25);
  const expirationValue = String(widget?.config?.expiration ?? definition?.defaultConfig?.expiration ?? '');
  const timeRangeValue = String(widget?.config?.range ?? definition?.defaultConfig?.range ?? '1M');
  const isNDateSkewWidget = String(widget?.type || '').startsWith('ndate-skew-');
  const controls = Object.keys(controlsConfig).length
    ? `<div class="widget-controls widget-controls-inline">
        ${controlsConfig.strike ? `<label class="widget-control">S
          <input type="${strikeInputType}" class="widget-strike-input" data-widget-param-widget-id="${widget.id}" data-widget-param-name="${WIDGET_PARAM_NAMES.BASE_STRIKE}" value="${strikeValue}" step="1" placeholder="ATM или 500" />
        </label>` : ''}
        ${controlsConfig.expiryStart ? `<label class="widget-control">E1
          <input type="text" class="widget-expiry-input" data-widget-param-widget-id="${widget.id}" data-widget-param-name="${WIDGET_PARAM_NAMES.EXPIRY_START}" value="${expiryStartValue}" placeholder="20260420" />
        </label>` : ''}
        ${controlsConfig.expiryEnd ? `<label class="widget-control">E2
          <input type="text" class="widget-expiry-input" data-widget-param-widget-id="${widget.id}" data-widget-param-name="${WIDGET_PARAM_NAMES.EXPIRY_END}" value="${expiryEndValue}" placeholder="20260424" />
        </label>` : ''}
        ${controlsConfig.strikeRange ? `<label class="widget-control">SR
          <input type="text" class="widget-sr-input" data-widget-param-widget-id="${widget.id}" data-widget-param-name="${WIDGET_PARAM_NAMES.STRIKE_RANGE}" value="${strikeRangeValue}" placeholder="[5,5,5,10] или 10" />
        </label>` : ''}
        ${controlsConfig.tailSteps ? `<label class="widget-control">N
          <input type="number" min="1" class="widget-tail-steps-input" data-widget-param-widget-id="${widget.id}" data-widget-param-name="${WIDGET_PARAM_NAMES.TAIL_STEPS}" value="${tailStepsValue}" />
        </label>` : ''}
        ${controlsConfig.optionType ? `<label class="widget-control">T
          <select class="widget-option-type-input" data-widget-param-widget-id="${widget.id}" data-widget-param-name="${WIDGET_PARAM_NAMES.OPTION_TYPE}">
            <option value="put" ${optionTypeValue === 'put' ? 'selected' : ''}>put</option>
            <option value="call" ${optionTypeValue === 'call' ? 'selected' : ''}>call</option>
          </select>
        </label>` : ''}
        ${controlsConfig.targetDelta ? `<label class="widget-control">D
          <input type="number" min="0.01" max="0.99" step="0.01" class="widget-target-delta-input" data-widget-param-widget-id="${widget.id}" data-widget-param-name="${WIDGET_PARAM_NAMES.TARGET_DELTA}" value="${targetDeltaValue}" />
        </label>` : ''}
        ${controlsConfig.expiration ? `<label class="widget-control">Exp
          <input type="text" class="widget-expiration-input" data-widget-param-widget-id="${widget.id}" data-widget-param-name="${WIDGET_PARAM_NAMES.EXPIRATION}" value="${expirationValue}" placeholder="20260612" />
        </label>` : ''}
        ${controlsConfig.timeRange ? `<label class="widget-control">R
          <select class="widget-range-input" data-widget-param-widget-id="${widget.id}" data-widget-param-name="${WIDGET_PARAM_NAMES.TIME_RANGE}">
            ${['1D', '1W', '1M', '6M'].map((range) => `<option value="${range}" ${timeRangeValue === range ? 'selected' : ''}>${range}</option>`).join('')}
          </select>
        </label>` : ''}
        ${isNDateSkewWidget ? `<div class="widget-control widget-history-control">
          <button type="button" class="widget-history-toggle" data-widget-history-toggle-widget-id="${widget.id}" title="History">H</button>
        </div>` : ''}
       </div>`
    : '';

  card.innerHTML = `
    <button class="btn btn-icon widget-remove-btn" data-widget-id="${widget.id}" aria-label="Remove widget" title="Remove widget">✕</button>
    <div class="widget-title" data-widget-collapse-handle="true" aria-expanded="${widget.collapsed ? 'false' : 'true'}" title="Double-click to ${widget.collapsed ? 'expand' : 'collapse'}">
      <h3>${widget.title || definition.defaultTitle}</h3>
      ${controls}
    </div>
    ${definition?.mode === 'table'
      ? `<div id="widget-body-${widget.id}" class="widget-body"></div>`
      : `<div id="chart-${widget.id}" class="widget-chart-host" data-chart-runtime="${chartRuntimeForDefinition(definition)}"><canvas id="canvas-${widget.id}"></canvas></div>`
    }
  `;

  return card;
}


function handleLegendClick(evt, legendItem, legend, onLegendVisibilityChange) {
  const chart = legend?.chart;
  const datasetIndex = Number.isInteger(legendItem?.datasetIndex)
    ? legendItem.datasetIndex
    : legendItem?.index;
  if (!chart || !Number.isInteger(datasetIndex)) return;
  const clickedDataset = chart.data.datasets?.[datasetIndex];
  const linkedHistoryIndices = Array.isArray(clickedDataset?.linkedHistoryIndices)
    ? clickedDataset.linkedHistoryIndices.filter((idx) => Number.isInteger(idx) && idx >= 0 && idx < chart.data.datasets.length)
    : [];
  const clickGroup = [datasetIndex, ...linkedHistoryIndices];

  const isCtrlClick = Boolean(evt?.native?.ctrlKey || evt?.ctrlKey);
  if (isCtrlClick) {
    const visibleIndices = chart.data.datasets
      .map((_, idx) => (chart.isDatasetVisible(idx) ? idx : null))
      .filter((idx) => idx != null);
    const allGroupVisible = clickGroup.every((idx) => chart.isDatasetVisible(idx));
    const visibleSet = new Set(visibleIndices);
    const isAlreadyIsolated = allGroupVisible
      && visibleIndices.length === clickGroup.length
      && clickGroup.every((idx) => visibleSet.has(idx));

    chart.data.datasets.forEach((_, idx) => {
      chart.setDatasetVisibility(idx, isAlreadyIsolated ? true : clickGroup.includes(idx));
    });
    chart.update('none');
    if (typeof onLegendVisibilityChange === 'function') onLegendVisibilityChange(chart);
    return;
  }

  const currentlyVisible = chart.isDatasetVisible(datasetIndex);
  clickGroup.forEach((idx) => chart.setDatasetVisibility(idx, !currentlyVisible));
  chart.update('none');
  if (typeof onLegendVisibilityChange === 'function') onLegendVisibilityChange(chart);
}

function generateDatasetLegendLabels(chart) {
  const datasets = Array.isArray(chart?.data?.datasets) ? chart.data.datasets : [];
  return datasets.map((dataset, datasetIndex) => {
    const color = dataset?.borderColor || dataset?.backgroundColor || '#7aa2ff';
    return {
      text: dataset?.label || `Series ${datasetIndex + 1}`,
      fillStyle: dataset?.backgroundColor || color,
      strokeStyle: color,
      lineWidth: dataset?.borderWidth ?? 1,
      fontColor: '#eaeaf0',
      hidden: !chart.isDatasetVisible(datasetIndex),
      datasetIndex,
      index: datasetIndex,
      pointStyle: dataset?.pointStyle || 'circle',
      lineDash: Array.isArray(dataset?.borderDash) ? dataset.borderDash : []
    };
  }).filter((item) => !datasets[item.datasetIndex]?.hiddenInLegend);
}

export function createWidgetChart(ctx, definition, options = {}) {
  return createChartJsWidgetChart(ctx, definition, options);
}

function createChartJsWidgetChart(ctx, definition, options = {}) {
  const onLegendVisibilityChange = options?.onLegendVisibilityChange;
  const hideXAxisValues = Boolean(definition?.hideXAxisValues);
  const chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        data: [],
        borderWidth: 1,
        tension: 0.2,
        pointRadius: 0,
        pointHitRadius: 0,
        pointHoverRadius: 0,
        borderColor: definition.color || '#7aa2ff'
      }]
    },
    options: {
      responsive: true,
      events: ['click'],
      animation: false,
      scales: {
        x: {
          ticks: {
            display: !hideXAxisValues
          }
        }
      },
      interaction: {
        mode: 'nearest',
        intersect: true
      },
      plugins: {
        title: {
          display: false,
          color: '#eaeaf0',
          font: { size: 11, weight: '600' },
          padding: { top: 0, bottom: 6 }
        },
        tooltip: {
          enabled: false
        },
        legend: {
          display: false,
          onClick: (evt, legendItem, legend) => handleLegendClick(evt, legendItem, legend, onLegendVisibilityChange),
          labels: {
            generateLabels: generateDatasetLegendLabels,
            color: '#eaeaf0',
            boxWidth: 8,
            boxHeight: 8,
            padding: 8,
            font: { size: 10 }
          }
        }
      }
    }
  });

  return chart;
}

function dataValueAt(dataset, idx, label) {
  const data = Array.isArray(dataset?.data) ? dataset.data : [];
  const direct = data[idx];
  if (direct && typeof direct === 'object' && String(direct.x) === String(label)) {
    return Number.isFinite(Number(direct.y)) ? Number(direct.y) : null;
  }
  if (Number.isFinite(Number(direct))) return Number(direct);
  const point = data.find((item) => item && typeof item === 'object' && String(item.x) === String(label));
  return Number.isFinite(Number(point?.y)) ? Number(point.y) : null;
}

function pointStrikeAt(dataset, idx, label) {
  const data = Array.isArray(dataset?.data) ? dataset.data : [];
  const direct = data[idx];
  if (direct && typeof direct === 'object' && String(direct.x) === String(label)) return direct.x;
  const point = data.find((item) => item && typeof item === 'object' && String(item.x) === String(label));
  if (point?.x != null) return point.x;
  return label;
}

function axisValues(labels) {
  return (labels || []).map((_, idx) => idx);
}

function cssPx(node, fallback) {
  const value = Number.parseFloat(getComputedStyle(node).height);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : fallback;
}

function seriesColor(dataset, fallback) {
  const color = dataset?.borderColor || dataset?.backgroundColor || fallback || '#7aa2ff';
  return Array.isArray(color) ? color[0] || fallback || '#7aa2ff' : color;
}

function seriesDash(dataset) {
  return Array.isArray(dataset?.borderDash) ? dataset.borderDash : [];
}

class UPlotWidgetChart {
  constructor(UPlot, host, definition, options = {}) {
    this.UPlot = UPlot;
    this.host = host;
    this.definition = definition || {};
    this.widgetId = options?.widgetId || null;
    this.onStatus = options?.onStatus;
    this.onLegendVisibilityChange = options?.onLegendVisibilityChange;
    this.data = {
      labels: [],
      datasets: [{
        data: [],
        borderWidth: 1,
        tension: 0.2,
        pointRadius: 0,
        pointHitRadius: 0,
        pointHoverRadius: 0,
        borderColor: this.definition.color || '#7aa2ff'
      }]
    };
    this.options = {
      plugins: {
        title: { display: false, text: '' },
        legend: { display: false, labels: {} }
      }
    };
    this._visible = [];
    this._plot = null;
    this._plotClickHandler = null;
    this._seriesSignature = '';
    this._lastBuild = { labels: [], visible: [] };
    this._legend = document.createElement('div');
    this._legend.className = 'widget-chart-legend';
    this._plotHost = document.createElement('div');
    this._plotHost.className = 'widget-uplot-host';
    this.host.replaceChildren(this._legend, this._plotHost);
  }

  isDatasetVisible(idx) {
    return this._visible[idx] !== false;
  }

  setDatasetVisibility(idx, visible) {
    this._visible[idx] = Boolean(visible);
  }

  _legendDisplay() {
    return Boolean(this.options?.plugins?.legend?.display);
  }

  _visibleDatasets() {
    return (Array.isArray(this.data.datasets) ? this.data.datasets : [])
      .map((dataset, idx) => ({ dataset, idx }))
      .filter(({ dataset, idx }) => this.isDatasetVisible(idx) && !dataset?.hidden);
  }

  _buildData() {
    const labels = Array.isArray(this.data.labels) ? this.data.labels.map(String) : [];
    const xs = axisValues(labels);
    const columns = [xs];
    const visible = this._visibleDatasets();
    visible.forEach(({ dataset }) => {
      columns.push(labels.map((label, idx) => dataValueAt(dataset, idx, label)));
    });
    return { labels, columns, visible };
  }

  _buildOptions(labels, visible) {
    const height = cssPx(this.host, 240);
    const width = Math.max(100, Math.round(this.host.clientWidth || this.host.getBoundingClientRect().width || 300));
    const hideXAxisValues = Boolean(this.definition?.hideXAxisValues);
    return {
      width,
      height,
      cursor: { show: false },
      legend: { show: false },
      scales: { x: { time: false } },
      axes: [
        {
          show: !hideXAxisValues,
          values: (_, vals) => vals.map((x) => labels[x] ?? ''),
          stroke: 'rgba(234,234,240,0.66)',
          grid: { show: false },
          ticks: { show: false },
          size: hideXAxisValues ? 0 : 24
        },
        {
          stroke: 'rgba(234,234,240,0.66)',
          grid: { stroke: 'rgba(234,234,240,0.10)', width: 1 },
          size: 46
        }
      ],
      series: [
        {},
        ...visible.map(({ dataset }) => ({
          label: dataset?.label || 'Series',
          stroke: seriesColor(dataset, this.definition.color),
          width: dataset?.borderWidth ?? 1,
          dash: seriesDash(dataset)
        }))
      ]
    };
  }

  _nearestPointFromClick(evt) {
    if (!this._plot || !evt) return null;
    const rect = this._plot.over?.getBoundingClientRect?.();
    if (!rect) return null;
    const left = evt.clientX - rect.left;
    const top = evt.clientY - rect.top;
    if (left < 0 || top < 0 || left > rect.width || top > rect.height) return null;

    const labels = this._lastBuild.labels || [];
    const idx = this._plot.posToIdx(left);
    const label = labels[idx];
    if (label == null) return null;

    const candidates = (this._lastBuild.visible || [])
      .filter(({ dataset }) => !dataset?.hiddenInLegend)
      .map(({ dataset, idx: datasetIndex }) => {
        const y = dataValueAt(dataset, idx, label);
        if (!Number.isFinite(y)) return null;
        const xPos = this._plot.valToPos(idx, 'x');
        const yPos = this._plot.valToPos(y, 'y');
        const distance = Math.hypot(left - xPos, top - yPos);
        return {
          dataset,
          datasetIndex,
          strike: pointStrikeAt(dataset, idx, label),
          distance
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.distance - b.distance);

    const nearest = candidates[0];
    return nearest && nearest.distance <= 10 ? nearest : null;
  }

  async _handlePlotClick(evt) {
    const prefix = this.definition?.clipboardChainPrefix;
    if (!prefix) return;
    const point = this._nearestPointFromClick(evt);
    if (!point) return;

    const result = strikeClipboardChain.click({
      widgetId: this.widgetId,
      prefix,
      strike: point.strike
    });
    if (!result.text) {
      if (typeof this.onStatus === 'function') this.onStatus(`strike selected: ${prefix} ${result.strike}`);
      return;
    }

    try {
      await navigator.clipboard.writeText(result.text);
      if (typeof this.onStatus === 'function') this.onStatus(`copied: ${result.text}`);
    } catch (err) {
      console.warn('Failed to copy strike chain to clipboard', err);
      if (typeof this.onStatus === 'function') {
        this.onStatus(`clipboard copy failed: ${err?.message || String(err)}`);
      }
    }
  }

  _bindPlotClick() {
    const over = this._plot?.over;
    if (!over || this._plotClickHandler) return;
    this._plotClickHandler = (evt) => {
      this._handlePlotClick(evt);
    };
    over.addEventListener('click', this._plotClickHandler);
  }

  _unbindPlotClick() {
    const over = this._plot?.over;
    if (over && this._plotClickHandler) over.removeEventListener('click', this._plotClickHandler);
    this._plotClickHandler = null;
  }

  _signatureFor(visible) {
    return visible.map(({ dataset, idx }) => JSON.stringify({
      idx,
      label: dataset?.label || `Series ${idx + 1}`,
      color: seriesColor(dataset, this.definition.color),
      width: dataset?.borderWidth ?? 1,
      dash: seriesDash(dataset)
    })).join('|');
  }

  _renderLegend() {
    const datasets = Array.isArray(this.data.datasets) ? this.data.datasets : [];
    const visibleItems = datasets
      .map((dataset, datasetIndex) => ({ dataset, datasetIndex }))
      .filter(({ dataset }) => !dataset?.hiddenInLegend);
    if (!this._legendDisplay() || !visibleItems.length) {
      this._legend.replaceChildren();
      this._legend.hidden = true;
      return;
    }

    this._legend.hidden = false;
    this._legend.replaceChildren(...visibleItems.map(({ dataset, datasetIndex }) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'widget-chart-legend-item';
      if (!this.isDatasetVisible(datasetIndex)) btn.classList.add('is-hidden');
      btn.dataset.datasetIndex = String(datasetIndex);
      const swatch = document.createElement('span');
      swatch.className = 'widget-chart-legend-swatch';
      swatch.style.background = seriesColor(dataset, this.definition.color);
      const label = document.createElement('span');
      label.textContent = dataset?.label || `Series ${datasetIndex + 1}`;
      btn.append(swatch, label);
      btn.addEventListener('click', (evt) => {
        handleLegendClick(evt, { datasetIndex, index: datasetIndex }, { chart: this }, this.onLegendVisibilityChange);
      });
      return btn;
    }));
  }

  update() {
    const { labels, columns, visible } = this._buildData();
    this._lastBuild = { labels, visible };
    const opts = this._buildOptions(labels, visible);
    const seriesSignature = this._signatureFor(visible);
    const shouldRecreate = this._plot && this._seriesSignature !== seriesSignature;
    if (shouldRecreate) {
      this._unbindPlotClick();
      this._plot.destroy();
      this._plot = null;
      this._plotHost.replaceChildren();
    }

    if (!this._plot) {
      this._plot = new this.UPlot(opts, columns, this._plotHost);
      this._seriesSignature = seriesSignature;
      this._bindPlotClick();
    } else {
      this._plot.setData(columns);
      this._plot.setSize({ width: opts.width, height: opts.height });
    }
    this._renderLegend();
  }

  destroy() {
    this._unbindPlotClick();
    this._plot?.destroy();
    this._plot = null;
    this.host.replaceChildren();
  }
}

export async function createWidgetChartForDefinition(host, definition, options = {}) {
  const runtime = chartRuntimeForDefinition(definition);
  if (runtime === 'uplot') {
    const UPlot = await ensureUPlotRuntime();
    return new UPlotWidgetChart(UPlot, host, definition, options);
  }

  await ensureChartJsRuntime();
  const canvas = host.querySelector('canvas');
  const ctx = canvas?.getContext('2d');
  return ctx ? createChartJsWidgetChart(ctx, definition, options) : null;
}
