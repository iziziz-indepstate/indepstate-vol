import { ensureChartJsRuntime } from './widget-renderers.js';

const states = new WeakMap();
const escape = (value) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const format = (value) => Number.isFinite(value) ? value.toFixed(2) : 'n/a';
const description = 'OLS: intercept + RC5 + RC10 + RC21 + EWMA10. Target: the next 21 SPX sessions. Up to 1260 completed training samples; minimum 504.';

export const correlationHarWidget = {
  type: 'correlation-har', defaultTitle: 'COR. Correlation HAR', mode: 'table', gridSpan: 6,
  refreshOnDashboardRefresh: false, defaultConfig: {},
  destroy(container) {
    const state = states.get(container);
    if (state) { state.version += 1; state.chart?.destroy(); clearInterval(state.timer); }
    states.delete(container);
  },
  async render({ container, widget, widgetData }) {
    correlationHarWidget.destroy(container);
    const state = { version: 0, chart: null, timer: null, busy: false, hasSnapshot: false, lastCheck: null };
    states.set(container, state);
    const current = () => states.get(container) === state;
    const publish = (payload) => widgetData?.publish?.({ ...payload, type: 'correlation-har',
      title: widget.title || correlationHarWidget.defaultTitle, config: { ...widget.config } });
    async function load(refresh = false) {
      if (state.busy) return;
      state.busy = true;
      const button = container.querySelector('[data-har-update]');
      if (button) { button.disabled = true; button.textContent = 'Updating…'; }
      try {
        const result = await window.appBridge.getCorrelationHarState({ refresh });
        if (!current()) return;
        if (!refresh && state.hasSnapshot && state.lastCheck === result.checkedAt) return;
        state.hasSnapshot = true;
        state.lastCheck = result.checkedAt;
        state.chart?.destroy(); state.chart = null;
        const latest = result.latest;
        container.innerHTML = `<div class="ivrv-controls"><button type="button" class="btn" data-har-update>Update data</button></div>
          <div class="rc-widget"><div class="ivrv-summary rc-summary">${[
            ['HAR Forecast 21D', latest?.forecast], ['COR1M', latest?.cor1m], ['Forecast − COR1M', latest?.spread],
            ['RC21', latest?.factors.rc21], ['EWMA10', latest?.factors.rcEwma]
          ].map(([label, value]) => `<div><span>${label}</span><strong>${format(value)}</strong></div>`).join('')}</div>
          <div class="ivrv-freshness">Forecast session: ${escape(latest?.date || 'unavailable')} · Issued: ${escape(latest?.issuedAt || 'n/a')} · Basket: ${escape(latest?.basketAsOf || 'n/a')} · Training samples: ${latest?.training.samples || 0}</div>
          <div class="ivrv-freshness">Last check: ${escape(result.checkedAt)} · Sources: Yahoo adjusted close / SPX, iShares IVV, Cboe COR1M</div>
          ${result.error ? `<div class="ivrv-error" role="status">${escape(result.error)}</div>` : ''}
          ${(result.warnings || []).map((warning) => `<div class="ivrv-warning">${escape(warning)}</div>`).join('')}
          <div class="ivrv-charts rc-charts"><div><h4>Issued forecasts and subsequent outcomes · correlation points</h4><canvas data-har-chart></canvas></div></div>
          <div class="ivrv-freshness">Dates identify forecast origins. Facts appear after 21 sessions. Only forecasts actually issued by this app are recorded; missed sessions are not backfilled.</div>
          <details class="rc-basket"><summary>Model and data</summary><p>${description}</p>
          <p>Current Top 50 IVV weights are applied to training history; historical constituent selection introduces bias. Each outcome uses its forecast's original basket. 21 sessions approximates the COR1M tenor.</p>
          <p>Training origins: ${escape(latest?.training.startDate || 'n/a')} – ${escape(latest?.training.endDate || 'n/a')} · Last known target: ${escape(latest?.training.lastTargetDate || 'n/a')}</p>
          <p>Coefficients: ${escape(latest ? JSON.stringify(latest.coefficients) : 'unavailable')}</p>
          <p>Stored in: ${escape(result.directory)}</p>
          <p style="overflow-wrap:anywhere">Source checks: ${escape(JSON.stringify(result.sources))}</p></details></div>`;
        container.querySelector('[data-har-update]')?.addEventListener('click', () => load(true));
        publish(result);
        const Chart = await ensureChartJsRuntime();
        if (!current()) return;
        const rows = result.records || [];
        state.chart = new Chart(container.querySelector('[data-har-chart]'), {
          type: 'line', data: { labels: rows.map((row) => row.date), datasets: [
            ['forecast', 'HAR Forecast 21D', '#38bdf8'], ['fact', 'Realized next 21 sessions', '#22c55e'], ['cor1m', 'COR1M at origin', '#a78bfa']
          ].map(([key, label, color]) => ({ label, data: rows.map((row) => row[key]), borderColor: color,
            borderWidth: 1.5, pointRadius: rows.length === 1 ? 3 : 0, pointHitRadius: 8, spanGaps: false, tension: 0 })) },
          options: { responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: 'index', intersect: false },
            plugins: { legend: { labels: { color: '#eaeaf0', boxWidth: 10 } }, tooltip: { callbacks: {
              label: (context) => `${context.dataset.label}: ${format(context.parsed.y)}`,
              afterBody: (items) => { const row = rows[items[0]?.dataIndex]; return row ? [
                `Issued: ${row.issuedAt}`, `Target ends: ${row.targetEndDate || 'pending (21 sessions)'}`, `Forecast − fact: ${format(row.error)}`] : []; }
            } } }, scales: { x: { ticks: { color: '#aaaab5', maxTicksLimit: 8 } }, y: { ticks: { color: '#aaaab5' } } } }
        });
      } catch (error) {
        if (!current()) return;
        container.innerHTML = `<div class="ivrv-error" role="status">Unable to load HAR: ${escape(error.message)}</div><button type="button" class="btn" data-har-update>Update data</button>`;
        container.querySelector('[data-har-update]')?.addEventListener('click', () => load(true));
        publish({ status: 'error', error: error.message });
      } finally { state.busy = false; }
    }
    container.innerHTML = '<div class="ivrv-status" role="status">Loading HAR model and saved forecasts… Initial history loading may take several minutes.</div>';
    await load();
    if (current()) { state.timer = setInterval(() => load(), 60000); state.timer.unref?.(); }
  }
};
