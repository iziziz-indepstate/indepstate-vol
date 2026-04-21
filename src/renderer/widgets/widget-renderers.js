export function createWidgetCard(widget, definition) {
  const card = document.createElement('article');
  card.className = 'widget-card';
  card.draggable = true;
  card.dataset.widgetCardId = widget.id;

  const strikeValue = Number(widget?.config?.baseStrike ?? definition?.defaultConfig?.baseStrike ?? 500);
  const expiryStartValue = String(widget?.config?.expiryStart ?? widget?.config?.expiry ?? definition?.defaultConfig?.expiryStart ?? '');
  const expiryEndValue = String(widget?.config?.expiryEnd ?? definition?.defaultConfig?.expiryEnd ?? '');
  const tickerValue = String(widget?.config?.ticker ?? definition?.defaultConfig?.ticker ?? '');

  const controls = definition.mode === 'snapshot-series'
    ? `<div class="widget-controls widget-controls-inline">
         <label class="widget-control">S
           <input type="number" class="widget-strike-input" data-widget-strike-id="${widget.id}" value="${strikeValue}" step="1" />
         </label>
         <label class="widget-control">E1
           <input type="text" class="widget-expiry-input" data-widget-expiry-start-id="${widget.id}" value="${expiryStartValue}" placeholder="20260420" />
         </label>
         <label class="widget-control">E2
           <input type="text" class="widget-expiry-input" data-widget-expiry-end-id="${widget.id}" value="${expiryEndValue}" placeholder="20260424" />
         </label>
         <label class="widget-control">T
           <input type="text" class="widget-ticker-input" data-widget-ticker-id="${widget.id}" value="${tickerValue}" placeholder="AMEX:SPY" />
         </label>
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

function handleLegendClick(evt, legendItem, legend) {
  const chart = legend?.chart;
  const datasetIndex = legendItem?.datasetIndex;
  if (!chart || !Number.isInteger(datasetIndex)) return;

  const isCtrlClick = Boolean(evt?.native?.ctrlKey || evt?.ctrlKey);
  if (isCtrlClick) {
    const visibleIndices = chart.data.datasets
      .map((_, idx) => (chart.isDatasetVisible(idx) ? idx : null))
      .filter((idx) => idx != null);
    const clickedIsVisible = chart.isDatasetVisible(datasetIndex);
    const isAlreadyIsolated = clickedIsVisible && visibleIndices.length === 1 && visibleIndices[0] === datasetIndex;

    chart.data.datasets.forEach((_, idx) => {
      chart.setDatasetVisibility(idx, isAlreadyIsolated ? true : idx === datasetIndex);
    });
    chart.update();
    return;
  }

  const currentlyVisible = chart.isDatasetVisible(datasetIndex);
  chart.setDatasetVisibility(datasetIndex, !currentlyVisible);
  chart.update();
}

export function createWidgetChart(ctx, definition) {
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
        legend: {
          display: false,
          onClick: handleLegendClick,
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
