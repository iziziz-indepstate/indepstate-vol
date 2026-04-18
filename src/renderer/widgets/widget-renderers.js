export function createWidgetCard(widget, definition) {
  const card = document.createElement('article');
  card.className = 'widget-card';

  const strikeValue = Number(widget?.config?.baseStrike ?? definition?.defaultConfig?.baseStrike ?? 500);
  const expiryValue = String(widget?.config?.expiry ?? definition?.defaultConfig?.expiry ?? '');
  const tickerValue = String(widget?.config?.ticker ?? definition?.defaultConfig?.ticker ?? '');

  const controls = definition.mode === 'snapshot-series'
    ? `<div class="widget-controls">
         <label class="widget-control">Strike
           <input type="number" class="widget-strike-input" data-widget-strike-id="${widget.id}" value="${strikeValue}" step="1" />
         </label>
         <label class="widget-control">Expiry
           <input type="text" class="widget-expiry-input" data-widget-expiry-id="${widget.id}" value="${expiryValue}" placeholder="20260227" />
         </label>
         <label class="widget-control">Ticker
           <input type="text" class="widget-ticker-input" data-widget-ticker-id="${widget.id}" value="${tickerValue}" placeholder="AMEX:SPY" />
         </label>
       </div>`
    : '';

  card.innerHTML = `
    <h3 class="widget-title">
      <span>${widget.title || definition.defaultTitle}</span>
      <button class="btn" data-widget-id="${widget.id}">Remove</button>
    </h3>
    ${controls}
    <canvas id="canvas-${widget.id}"></canvas>
  `;

  return card;
}

export function createWidgetChart(ctx, definition) {
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
      plugins: { legend: { display: false } }
    }
  });
}
