import { calculateForwardVols } from '../../shared/forward-vol-calculations.mjs';

const charts = new WeakMap();
const renderVersions = new WeakMap();

function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function fmt(value, digits = 2) {
  return Number.isFinite(value) ? Number(value).toFixed(digits) : 'n/a';
}

function destroyChart(container) {
  charts.get(container)?.destroy();
  charts.delete(container);
}

function straddleLabel(snapshot, source) {
  const cfg = source?.config || {};
  const base = cfg.expiryOverride || snapshot.tenor || snapshot.expiry;
  return String(base || snapshot.expiry);
}

function createChart(container, segments) {
  const labels = segments.map((segment) => `${segment.fromLabel}->${segment.toLabel}`);
  const data = segments.map((segment) => (segment.status === 'ok' ? segment.forwardVolPercent : null));
  const chart = new Chart(container.querySelector('[data-vol-upfront-chart]'), {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Forward vol',
        data,
        borderColor: '#38bdf8',
        backgroundColor: 'rgba(56, 189, 248, 0.16)',
        borderWidth: 1.5,
        pointRadius: 3,
        pointHitRadius: 12,
        tension: 0.15,
        spanGaps: false
      }]
    },
    options: {
      responsive: true,
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (context) => `Forward vol: ${fmt(context.parsed.y, 2)}%`
          }
        }
      },
      scales: {
        x: { ticks: { color: 'rgba(234,234,240,0.65)' } },
        y: {
          ticks: {
            color: 'rgba(234,234,240,0.65)',
            callback: (value) => `${value}%`
          }
        }
      }
    }
  });
  charts.set(container, chart);
}

function renderTable(points, segments) {
  return `
    <div class="vol-upfront-info">
      <div class="vol-upfront-points">
        ${points.map((point) => `<span>${esc(point.label)}: DTE ${fmt(point.dte, 1)} / ATM IV ${fmt(point.iv * 100, 1)}%</span>`).join('')}
      </div>
      <table class="vol-upfront-table">
        <thead><tr>
          <th>Segment</th><th>DTE</th><th>Total Var</th><th>Fwd Var</th><th>Fwd Vol</th><th>Status</th>
        </tr></thead>
        <tbody>
          ${segments.map((segment) => `<tr>
            <td>${esc(segment.fromLabel)} -> ${esc(segment.toLabel)}</td>
            <td>${fmt(segment.fromDte, 1)} -> ${fmt(segment.toDte, 1)}</td>
            <td>${fmt(segment.totalVarianceFrom, 4)} -> ${fmt(segment.totalVarianceTo, 4)}</td>
            <td>${fmt(segment.forwardVariance, 4)}</td>
            <td>${Number.isFinite(segment.forwardVolPercent) ? `${fmt(segment.forwardVolPercent, 1)}%` : 'n/a'}</td>
            <td><span class="vol-upfront-status ${segment.status === 'ok' ? 'ok' : 'bad'}">${esc(segment.status)}</span></td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
  `;
}

export const volUpfrontWidget = {
  type: 'vol-upfront',
  mode: 'table',
  gridSpan: 6,
  consumesWidgetData: true,
  defaultTitle: 'Vol Upfront',
  destroy: destroyChart,
  render: async ({ container, widgetData }) => {
    const renderVersion = (renderVersions.get(container) || 0) + 1;
    renderVersions.set(container, renderVersion);
    destroyChart(container);

    const straddleOutputs = widgetData?.readByType?.('atm-straddle') || [];
    if (straddleOutputs.length < 2) {
      container.innerHTML = '<div class="vol-upfront-content"><div class="vol-upfront-empty">Add at least two Straddle ATM widgets to calculate forward vol.</div></div>';
      return;
    }

    const points = [];
    const errors = [];
    for (const output of straddleOutputs) {
      if (output.status !== 'ok') {
        errors.push(`${output.title || 'Straddle ATM'}: ${output.error || 'unavailable'}`);
        continue;
      }

      const straddle = output.snapshot;
      if (Number.isFinite(straddle?.dte) && Number.isFinite(straddle?.atmIv)) {
        points.push({
          label: straddleLabel(straddle, output),
          dte: straddle.dte,
          iv: straddle.atmIv
        });
      }
    }

    const segments = calculateForwardVols(points);
    if (renderVersions.get(container) !== renderVersion) return;

    if (points.length < 2 || !segments.length) {
      container.innerHTML = `
        <div class="vol-upfront-content">
          <div class="vol-upfront-empty">Need at least two valid Straddle ATM readings.</div>
          ${errors.length ? `<div class="vol-upfront-warning">${errors.map(esc).join('<br>')}</div>` : ''}
        </div>
      `;
      return;
    }

    container.innerHTML = `
      <div class="vol-upfront-content">
        <div class="vol-upfront-chart-wrap"><canvas data-vol-upfront-chart></canvas></div>
        ${renderTable([...points].sort((a, b) => a.dte - b.dte), segments)}
        ${errors.length ? `<div class="vol-upfront-warning">${errors.map(esc).join('<br>')}</div>` : ''}
      </div>
    `;
    createChart(container, segments);
  }
};
