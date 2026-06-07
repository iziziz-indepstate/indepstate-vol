const SPREAD_TYPES = ['put_credit', 'call_credit', 'put_debit', 'call_debit'];
const SPREAD_TYPE_FILTER_OPTIONS = ['all', ...SPREAD_TYPES];
const SORTS = ['efficiencyScore', 'creditToWidth', 'rewardToRisk', 'ivRichnessVsAtm', 'distanceBreakevenPct', 'liquidityScore', 'maxProfit', 'maxLoss'];

function toNum(x) {
  if (x == null) return null;
  if (typeof x === 'string' && x.trim() === '') return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function avg(values) {
  const valid = values.filter((x) => Number.isFinite(x));
  if (!valid.length) return null;
  return valid.reduce((a, b) => a + b, 0) / valid.length;
}

function computeVelocityByType(quotes, type) {
  const same = quotes.filter((q) => q.type === type && Number.isFinite(q.strike));
  same.sort((a, b) => a.strike - b.strike);
  const byKey = new Map();
  for (let i = 0; i < same.length; i += 1) {
    const prev = same[i - 1];
    const curr = same[i];
    const next = same[i + 1];
    if (!curr || !Number.isFinite(curr.iv)) continue;
    if (!prev || !next || !Number.isFinite(prev.iv) || !Number.isFinite(next.iv)) {
      byKey.set(`${curr.type}:${curr.strike}`, null);
      continue;
    }
    const dK = (next.strike - prev.strike);
    byKey.set(`${curr.type}:${curr.strike}`, dK > 0 ? (next.iv - prev.iv) / dK : null);
  }
  return byKey;
}

function normalize01(v, min, max) {
  if (!Number.isFinite(v) || !Number.isFinite(min) || !Number.isFinite(max)) return 0;
  if (max <= min) return 0.5;
  return Math.max(0, Math.min(1, (v - min) / (max - min)));
}

function oppositeSpreadStyle(type) {
  return type.includes('credit') ? 'credit' : 'debit';
}

function parseSpreadTypes(raw) {
  if (Array.isArray(raw) && raw.length) return raw.filter((x) => SPREAD_TYPES.includes(x));
  if (typeof raw === 'string' && SPREAD_TYPES.includes(raw)) return [raw];
  return [...SPREAD_TYPES];
}

function spreadPnlAtPrice(spreadType, shortStrike, longStrike, net, price) {
  if (!Number.isFinite(price)) return null;
  if (spreadType === 'put_credit') {
    return net - Math.max(0, shortStrike - price) + Math.max(0, longStrike - price);
  }
  if (spreadType === 'call_credit') {
    return net - Math.max(0, price - shortStrike) + Math.max(0, price - longStrike);
  }
  if (spreadType === 'put_debit') {
    return Math.max(0, longStrike - price) - Math.max(0, shortStrike - price) - net;
  }
  return Math.max(0, price - longStrike) - Math.max(0, price - shortStrike) - net;
}

function buildCandidates(snapshot, config) {
  const expiry = String(config.expiry || snapshot?.expiry || '').trim();
  const expirySnapshot = snapshot?.byExpiry?.[expiry] || snapshot;
  const quotesRaw = Array.isArray(expirySnapshot?.optionQuotes) ? expirySnapshot.optionQuotes : [];
  const spot = toNum(snapshot?.px);
  if (!quotesRaw.length || !Number.isFinite(spot)) return [];

  const strikeMin = toNum(config.strikeMin) ?? spot * 0.9;
  const strikeMax = toNum(config.strikeMax) ?? spot * 1.1;
  const minWidth = Math.max(0, toNum(config.minWidth) ?? 1);
  const maxWidth = Math.max(minWidth, toNum(config.maxWidth) ?? 1000);
  const minCredit = Math.max(0, toNum(config.minCredit) ?? 0);
  const maxDebit = Math.max(0, toNum(config.maxDebit) ?? Number.POSITIVE_INFINITY);
  const minRewardToRisk = Math.max(0, toNum(config.minRewardToRisk) ?? 0);
  const minCreditToWidth = Math.max(0, toNum(config.minCreditToWidth) ?? 0);
  const maxAllowedSpreadPct = toNum(config.maxAllowedSpreadPct) ?? 0.35;
  const regimeBias = String(config.regimeBias || 'neutral');
  const expectedMoveLow = toNum(config.expectedMoveLow);
  const expectedMoveHigh = toNum(config.expectedMoveHigh);
  const enforceExpectedMoveRange = Boolean(config.enforceExpectedMoveRange);

  const quotes = quotesRaw
    .filter((q) => Number.isFinite(q.strike) && q.strike >= strikeMin && q.strike <= strikeMax)
    .map((q) => ({ ...q }));

  const velocityMap = new Map([
    ...computeVelocityByType(quotes, 'put').entries(),
    ...computeVelocityByType(quotes, 'call').entries()
  ]);
  quotes.forEach((q) => {
    const k = `${q.type}:${q.strike}`;
    q.velocity = velocityMap.get(k) ?? null;
  });

  const byType = {
    put: quotes.filter((q) => q.type === 'put').sort((a, b) => a.strike - b.strike),
    call: quotes.filter((q) => q.type === 'call').sort((a, b) => a.strike - b.strike)
  };

  const spreadTypeFilter = String(config.spreadTypeFilter || 'all');
  const types = spreadTypeFilter !== 'all' && SPREAD_TYPES.includes(spreadTypeFilter)
    ? [spreadTypeFilter]
    : parseSpreadTypes(config.spreadTypes);
  const atmIv = toNum(config.atmIv) ?? toNum(expirySnapshot?.atmIv);

  const candidates = [];
  function legBad(leg) {
    if (!leg) return true;
    if (!Number.isFinite(leg.bid) || !Number.isFinite(leg.ask) || !Number.isFinite(leg.iv)) return true;
    if (leg.bid <= 0 || leg.ask <= 0 || leg.ask < leg.bid) return true;
    const mid = (leg.bid + leg.ask) / 2;
    const spreadPct = (leg.ask - leg.bid) / mid;
    if (Number.isFinite(maxAllowedSpreadPct) && spreadPct > maxAllowedSpreadPct) return true;
    return false;
  }

  for (const spreadType of types) {
    const optionType = spreadType.startsWith('put') ? 'put' : 'call';
    const arr = byType[optionType];

    for (let i = 0; i < arr.length; i += 1) {
      for (let j = 0; j < arr.length; j += 1) {
        if (i === j) continue;
        const a = arr[i];
        const b = arr[j];
        let shortLeg = null;
        let longLeg = null;

        if (spreadType === 'put_credit' && a.strike > b.strike) {
          shortLeg = a; longLeg = b;
        } else if (spreadType === 'call_credit' && a.strike < b.strike) {
          shortLeg = a; longLeg = b;
        } else if (spreadType === 'put_debit' && a.strike < b.strike) {
          shortLeg = a; longLeg = b;
        } else if (spreadType === 'call_debit' && a.strike > b.strike) {
          shortLeg = a; longLeg = b;
        }
        if (!shortLeg || !longLeg) continue;
        if (legBad(shortLeg) || legBad(longLeg)) continue;

        const width = Math.abs(shortLeg.strike - longLeg.strike);
        if (!Number.isFinite(width) || width < minWidth || width > maxWidth || width <= 0) continue;

        const isCredit = spreadType.includes('credit');
        const useMid = Boolean(config.useMid);
        const credit = useMid ? (shortLeg.mid - longLeg.mid) : (shortLeg.bid - longLeg.ask);
        const debit = useMid ? (longLeg.mid - shortLeg.mid) : (longLeg.ask - shortLeg.bid);
        const net = isCredit ? credit : debit;
        if (!Number.isFinite(net) || net <= 0) continue;
        if (isCredit && net < minCredit) continue;
        if (!isCredit && net > maxDebit) continue;

        const maxProfit = isCredit ? net : width - net;
        const maxLoss = isCredit ? width - net : net;
        if (!(maxLoss > 0) || !(maxProfit > 0)) continue;
        const rewardToRisk = maxProfit / maxLoss;
        if (rewardToRisk < minRewardToRisk) continue;

        const breakeven = spreadType === 'put_credit' ? (shortLeg.strike - net)
          : spreadType === 'call_credit' ? (shortLeg.strike + net)
            : spreadType === 'put_debit' ? (longLeg.strike - net)
              : (longLeg.strike + net);

        const creditToWidth = isCredit ? net / width : null;
        const debitToWidth = !isCredit ? net / width : null;
        if (isCredit && creditToWidth < minCreditToWidth) continue;

        const shortMid = (shortLeg.bid + shortLeg.ask) / 2;
        const longMid = (longLeg.bid + longLeg.ask) / 2;
        const shortSpreadPct = (shortLeg.ask - shortLeg.bid) / shortMid;
        const longSpreadPct = (longLeg.ask - longLeg.bid) / longMid;

        const ivDiff = shortLeg.iv - longLeg.iv;
        const ivRichnessVsAtm = Number.isFinite(atmIv) ? (shortLeg.iv - atmIv) : 0;
        const avgVelocity = avg([shortLeg.velocity, longLeg.velocity]);

        const shortInsideExpectedMove = Number.isFinite(expectedMoveLow) && Number.isFinite(expectedMoveHigh)
          ? shortLeg.strike >= expectedMoveLow && shortLeg.strike <= expectedMoveHigh
          : null;
        const breakevenInsideExpectedMove = Number.isFinite(expectedMoveLow) && Number.isFinite(expectedMoveHigh)
          ? breakeven >= expectedMoveLow && breakeven <= expectedMoveHigh
          : null;
        const emCheckPrices = [];
        if (Number.isFinite(expectedMoveLow)) emCheckPrices.push(expectedMoveLow);
        if (Number.isFinite(expectedMoveHigh)) emCheckPrices.push(expectedMoveHigh);
        if (Number.isFinite(expectedMoveLow) && Number.isFinite(expectedMoveHigh)) {
          emCheckPrices.push((expectedMoveLow + expectedMoveHigh) / 2);
        }
        const hasProfitInsideExpectedMove = emCheckPrices.length
          ? emCheckPrices.some((price) => (spreadPnlAtPrice(spreadType, shortLeg.strike, longLeg.strike, net, price) ?? Number.NEGATIVE_INFINITY) > 0)
          : true;

        if (enforceExpectedMoveRange && !hasProfitInsideExpectedMove) continue;

        const longLegCostRatio = longLeg.ask / shortLeg.bid;
        const creditCaptureRatio = isCredit ? net / shortLeg.bid : null;

        const flags = [];
        if (shortInsideExpectedMove) flags.push('SHORT_STRIKE_INSIDE_EXPECTED_MOVE');
        if (breakevenInsideExpectedMove) flags.push('BREAKEVEN_INSIDE_EXPECTED_MOVE');
        if (shortSpreadPct > 0.2 || longSpreadPct > 0.2) flags.push('WIDE_BID_ASK');
        if (longLegCostRatio > 0.75) flags.push('LONG_LEG_EXPENSIVE');
        if (isCredit && creditToWidth < 0.08) flags.push('LOW_CREDIT_TO_WIDTH');
        if (rewardToRisk < 0.1) flags.push('POOR_REWARD_TO_RISK');
        if (Math.abs(spot - shortLeg.strike) / spot < 0.015) flags.push('SHORT_STRIKE_CLOSE_TO_SPOT');
        if (!Number.isFinite(shortLeg.velocity) || !Number.isFinite(longLeg.velocity)) flags.push('MISSING_VELOCITY');
        if (regimeBias === 'squeeze' && spreadType === 'call_credit') flags.push('CALL_CREDIT_IN_SQUEEZE_REGIME');
        if (regimeBias === 'risk_off' && spreadType === 'put_credit') flags.push('PUT_CREDIT_IN_RISK_OFF_REGIME');

        candidates.push({
          spreadType,
          expiry,
          shortLeg: `${shortLeg.strike}${optionType === 'put' ? 'P' : 'C'}`,
          longLeg: `${longLeg.strike}${optionType === 'put' ? 'P' : 'C'}`,
          shortStrike: shortLeg.strike,
          longStrike: longLeg.strike,
          width,
          credit: isCredit ? net : null,
          debit: !isCredit ? net : null,
          maxProfit,
          maxLoss,
          breakeven,
          rewardToRisk,
          creditToWidth,
          debitToWidth,
          shortIv: shortLeg.iv,
          longIv: longLeg.iv,
          ivDiff,
          ivRichnessVsAtm,
          shortBid: shortLeg.bid,
          longAsk: longLeg.ask,
          creditCaptureRatio,
          longLegCostRatio,
          shortVelocity: shortLeg.velocity,
          longVelocity: longLeg.velocity,
          avgVelocity,
          distanceShortPct: Math.abs(spot - shortLeg.strike) / spot,
          distanceBreakevenPct: Math.abs(spot - breakeven) / spot,
          shortInsideExpectedMove,
          breakevenInsideExpectedMove,
          bidAskSpreadPctShort: shortSpreadPct,
          bidAskSpreadPctLong: longSpreadPct,
          liquidityScore: Math.max(0, 100 - ((shortSpreadPct + longSpreadPct) * 100)),
          flags
        });
      }
    }
  }

  const basis = {
    creditToWidth: candidates.map((x) => x.creditToWidth ?? x.debitToWidth ?? 0),
    rewardToRisk: candidates.map((x) => x.rewardToRisk ?? 0),
    ivRichnessVsAtm: candidates.map((x) => x.ivRichnessVsAtm ?? 0),
    avgVelocity: candidates.map((x) => x.avgVelocity ?? 0),
    distanceBreakevenPct: candidates.map((x) => x.distanceBreakevenPct ?? 0),
    creditCaptureRatio: candidates.map((x) => x.creditCaptureRatio ?? 0),
    longLegCostRatio: candidates.map((x) => x.longLegCostRatio ?? 0)
  };

  const mm = Object.fromEntries(Object.entries(basis).map(([k, arr]) => [k, {
    min: Math.min(...arr),
    max: Math.max(...arr)
  }]));

  for (const row of candidates) {
    const creditStyle = oppositeSpreadStyle(row.spreadType) === 'credit';
    let regimePenalty = 0;
    if (regimeBias === 'bullish') {
      if (row.spreadType === 'put_credit' || row.spreadType === 'call_debit') regimePenalty -= 0.06;
      if (row.spreadType === 'call_credit') regimePenalty += 0.08;
      if (row.spreadType === 'put_debit') regimePenalty += 0.03;
    }
    if (regimeBias === 'bearish') {
      if (row.spreadType === 'call_credit' || row.spreadType === 'put_debit') regimePenalty -= 0.06;
      if (row.spreadType === 'put_credit') regimePenalty += 0.08;
      if (row.spreadType === 'call_debit') regimePenalty += 0.03;
    }
    if (regimeBias === 'squeeze' && row.spreadType === 'call_credit') regimePenalty += 0.12;
    if (regimeBias === 'risk_off' && row.spreadType === 'put_credit') regimePenalty += 0.12;

    const liquidityPenalty = row.flags.includes('WIDE_BID_ASK') ? 0.08 : 0;
    const expectedMovePenalty = row.shortInsideExpectedMove ? 0.09 : 0;

    const creditScore =
      0.30 * normalize01(row.creditToWidth ?? 0, mm.creditToWidth.min, mm.creditToWidth.max)
      + 0.20 * normalize01(row.rewardToRisk, mm.rewardToRisk.min, mm.rewardToRisk.max)
      + 0.20 * normalize01(row.ivRichnessVsAtm, mm.ivRichnessVsAtm.min, mm.ivRichnessVsAtm.max)
      + 0.10 * normalize01(row.avgVelocity ?? 0, mm.avgVelocity.min, mm.avgVelocity.max)
      + 0.10 * normalize01(row.distanceBreakevenPct, mm.distanceBreakevenPct.min, mm.distanceBreakevenPct.max)
      + 0.10 * normalize01(row.creditCaptureRatio ?? 0, mm.creditCaptureRatio.min, mm.creditCaptureRatio.max)
      - 0.15 * normalize01(row.longLegCostRatio, mm.longLegCostRatio.min, mm.longLegCostRatio.max)
      - liquidityPenalty - expectedMovePenalty - regimePenalty;

    const debitScore =
      0.30 * normalize01(row.rewardToRisk, mm.rewardToRisk.min, mm.rewardToRisk.max)
      + 0.20 * normalize01((row.maxProfit / (row.debit || 1)), 0, 8)
      + 0.15 * normalize01(row.ivRichnessVsAtm, mm.ivRichnessVsAtm.min, mm.ivRichnessVsAtm.max)
      + 0.15 * normalize01(-row.ivDiff, -1, 1)
      + 0.10 * normalize01(row.distanceBreakevenPct, mm.distanceBreakevenPct.min, mm.distanceBreakevenPct.max)
      + 0.10 * normalize01(row.avgVelocity ?? 0, mm.avgVelocity.min, mm.avgVelocity.max)
      - liquidityPenalty - regimePenalty;

    row.efficiencyScore = Math.max(0, Math.min(100, Math.round((creditStyle ? creditScore : debitScore) * 100)));
  }

  return candidates;
}

function fmt(x, d = 2) {
  if (!Number.isFinite(x)) return 'n/a';
  return x.toFixed(d);
}

function spreadLabel(type) {
  return type.replace('_', ' ');
}

function sortRows(rows, sortBy) {
  const key = SORTS.includes(sortBy) ? sortBy : 'efficiencyScore';
  rows.sort((a, b) => {
    const av = a[key] ?? 0;
    const bv = b[key] ?? 0;
    if (key === 'maxLoss') return av - bv;
    return bv - av;
  });
  rows.forEach((r, idx) => { r.rank = idx + 1; });
}

function bindControls(container, widget, onChange) {
  container.querySelectorAll('[data-spread-opt-param]').forEach((el) => {
    el.addEventListener('change', (evt) => {
      const name = evt.target.dataset.spreadOptParam;
      let value = evt.target.value;
      if (evt.target.type === 'number') value = toNum(value);
      if (evt.target.type === 'checkbox') value = evt.target.checked;
      widget.config ||= {};
      widget.config[name] = value;
      onChange();
    });
  });
}

export const spreadOptimizerWidget = {
  type: 'spread-optimizer',
  mode: 'table',
  defaultTitle: 'SpreadOptimizer',
  defaultConfig: {
    spreadTypes: [...SPREAD_TYPES],
    spreadTypeFilter: 'all',
    strikeMin: null,
    strikeMax: null,
    minWidth: 1,
    maxWidth: 25,
    minCredit: 0,
    maxDebit: 10,
    minRewardToRisk: 0,
    minCreditToWidth: 0,
    maxAllowedSpreadPct: 0.35,
    regimeBias: 'neutral',
    sortBy: 'efficiencyScore',
    useMid: false,
    expectedMoveLow: null,
    expectedMoveHigh: null,
    enforceExpectedMoveRange: true
  },
  render: ({ container, snapshot, widget, widgetData, onConfigChange }) => {
    const cfg = widget.config || {};
    const candidates = buildCandidates(snapshot || {}, cfg);
    sortRows(candidates, cfg.sortBy);
    const top = candidates.slice(0, 50);
    widgetData?.publish?.({
      type: spreadOptimizerWidget.type,
      status: snapshot ? 'ok' : 'no_snapshot',
      title: widget.title || spreadOptimizerWidget.defaultTitle,
      config: { ...cfg },
      sourceSnapshotTime: snapshot?.time || null,
      candidates: top,
      totalCandidates: candidates.length
    });

    container.innerHTML = `
      <div class="spread-opt-controls">
        <label>Strike Min <input data-spread-opt-param="strikeMin" type="number" value="${cfg.strikeMin ?? ''}" /></label>
        <label>Strike Max <input data-spread-opt-param="strikeMax" type="number" value="${cfg.strikeMax ?? ''}" /></label>
        <label>Min W <input data-spread-opt-param="minWidth" type="number" value="${cfg.minWidth ?? 1}" /></label>
        <label>Max W <input data-spread-opt-param="maxWidth" type="number" value="${cfg.maxWidth ?? 25}" /></label>
        <label>Regime
          <select data-spread-opt-param="regimeBias">
            ${['neutral', 'bullish', 'bearish', 'fragile_bullish', 'risk_off', 'squeeze'].map((x) => `<option value="${x}" ${cfg.regimeBias === x ? 'selected' : ''}>${x}</option>`).join('')}
          </select>
        </label>
        <label>Type
          <select data-spread-opt-param="spreadTypeFilter">
            ${SPREAD_TYPE_FILTER_OPTIONS.map((x) => `<option value="${x}" ${String(cfg.spreadTypeFilter || 'all') === x ? 'selected' : ''}>${x}</option>`).join('')}
          </select>
        </label>
        <label>Sort
          <select data-spread-opt-param="sortBy">
            ${SORTS.map((x) => `<option value="${x}" ${cfg.sortBy === x ? 'selected' : ''}>${x}</option>`).join('')}
          </select>
        </label>
        <label>EM Low <input data-spread-opt-param="expectedMoveLow" type="number" value="${cfg.expectedMoveLow ?? ''}" /></label>
        <label>EM High <input data-spread-opt-param="expectedMoveHigh" type="number" value="${cfg.expectedMoveHigh ?? ''}" /></label>
        <label class="spread-opt-checkbox"><input data-spread-opt-param="useMid" type="checkbox" ${cfg.useMid ? 'checked' : ''}/> Use Mid</label>
        <label class="spread-opt-checkbox"><input data-spread-opt-param="enforceExpectedMoveRange" type="checkbox" ${cfg.enforceExpectedMoveRange ? 'checked' : ''}/> Only EM Range</label>
      </div>
      <div class="spread-opt-table-wrap">
        <table class="spread-opt-table">
          <thead><tr>
            <th>Rank</th><th>Type</th><th>Legs</th><th>Width</th><th>Credit/Debit</th><th>Max P</th><th>Max L</th><th>BE</th><th>R/R</th><th>IV Δ</th><th>Avg Vel</th><th>BE Dist%</th><th>Liq</th><th>Eff</th><th>Flags</th>
          </tr></thead>
          <tbody>
            ${top.map((r) => `<tr>
              <td>${r.rank}</td>
              <td>${spreadLabel(r.spreadType)}</td>
              <td>Sell ${r.shortLeg} / Buy ${r.longLeg}</td>
              <td>${fmt(r.width, 0)}</td>
              <td>${fmt(r.credit ?? r.debit)} / $${fmt((r.credit ?? r.debit) * 100, 0)}</td>
              <td>${fmt(r.maxProfit)} / $${fmt(r.maxProfit * 100, 0)}</td>
              <td>${fmt(r.maxLoss)} / $${fmt(r.maxLoss * 100, 0)}</td>
              <td>${fmt(r.breakeven)}</td>
              <td>${fmt(r.rewardToRisk)}</td>
              <td>${fmt(r.ivDiff, 3)}</td>
              <td>${fmt(r.avgVelocity, 4)}</td>
              <td>${fmt(r.distanceBreakevenPct * 100, 2)}%</td>
              <td>${fmt(r.liquidityScore, 0)}</td>
              <td><span class="spread-opt-eff ${r.efficiencyScore >= 70 ? 'good' : r.efficiencyScore < 40 ? 'bad' : ''}">${r.efficiencyScore}</span></td>
              <td>${r.flags.map((f) => `<span class="spread-opt-flag">${f}</span>`).join(' ')}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    `;

    bindControls(container, widget, onConfigChange);
  }
};
