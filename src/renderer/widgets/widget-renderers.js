import { WIDGET_PARAM_NAMES } from './widget-params.js';

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
      : `<canvas id="canvas-${widget.id}"></canvas>`
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
      events: [],
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
