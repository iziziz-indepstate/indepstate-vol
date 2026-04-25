import { WIDGET_PARAM_NAMES } from './widget-params.js';

export function createWidgetCard(widget, definition) {
  const card = document.createElement('article');
  card.className = 'widget-card';
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
        ${isNDateSkewWidget ? `<div class="widget-control widget-history-control">
          <button type="button" class="widget-history-toggle" data-widget-history-toggle-widget-id="${widget.id}" title="History">H</button>
        </div>` : ''}
       </div>`
    : '';

  card.innerHTML = `
    <button class="btn btn-icon widget-remove-btn" data-widget-id="${widget.id}" aria-label="Remove widget" title="Remove widget">✕</button>
    <div class="widget-title">
      <h3>${widget.title || definition.defaultTitle}</h3>
      ${controls}
    </div>
    <canvas id="canvas-${widget.id}"></canvas>
  `;

  return card;
}


function defaultTooltipLabel(context) {
  const datasetLabel = context?.dataset?.label ? `${context.dataset.label}: ` : '';
  const y = context?.parsed?.y;
  return `${datasetLabel}${Number.isFinite(y) ? y : 'n/a'}`;
}

function tooltipLabelCallback(context) {
  const formatter = context?.dataset?.tooltipFormatter;
  if (typeof formatter === 'function') {
    const formatted = formatter(context);
    if (Array.isArray(formatted)) return formatted;
    if (formatted == null) return '';
    return String(formatted);
  }

  return defaultTooltipLabel(context);
}

function handleLegendClick(evt, legendItem, legend, onLegendVisibilityChange) {
  const chart = legend?.chart;
  const datasetIndex = legendItem?.datasetIndex;
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
    chart.update();
    if (typeof onLegendVisibilityChange === 'function') onLegendVisibilityChange(chart);
    return;
  }

  const currentlyVisible = chart.isDatasetVisible(datasetIndex);
  clickGroup.forEach((idx) => chart.setDatasetVisibility(idx, !currentlyVisible));
  chart.update();
  if (typeof onLegendVisibilityChange === 'function') onLegendVisibilityChange(chart);
}

export function createWidgetChart(ctx, definition, options = {}) {
  const onLegendVisibilityChange = options?.onLegendVisibilityChange;
  const hideXAxisValues = Boolean(definition?.hideXAxisValues);
  return new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        data: [],
        borderWidth: 1,
        tension: 0.2,
        pointRadius: 0,
        borderColor: definition.color || '#7aa2ff'
      }]
    },
    options: {
      responsive: true,
      animation: false,
      scales: {
        x: {
          ticks: {
            display: !hideXAxisValues
          }
        }
      },
      plugins: {
        tooltip: {
          callbacks: {
            label: tooltipLabelCallback
          }
        },
        legend: {
          display: false,
          onClick: (evt, legendItem, legend) => handleLegendClick(evt, legendItem, legend, onLegendVisibilityChange),
          labels: {
            boxWidth: 8,
            boxHeight: 8,
            padding: 8,
            font: { size: 10 }
          }
        }
      }
    }
  });
}
