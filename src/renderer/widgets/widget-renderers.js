export function createWidgetCard(widget, definition) {
  const card = document.createElement('article');
  card.className = 'widget-card';

  const strikeControl = definition.mode === 'snapshot-series'
    ? `<label class="widget-control">Strike
         <input type="number" class="widget-strike-input" data-widget-strike-id="${widget.id}" value="${Number(widget?.config?.baseStrike ?? definition?.defaultConfig?.baseStrike ?? 500)}" step="1" />
       </label>`
    : '';

  card.innerHTML = `
    <h3 class="widget-title">
      <span>${widget.title || definition.defaultTitle}</span>
      <button class="btn" data-widget-id="${widget.id}">Remove</button>
    </h3>
    ${strikeControl}
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
