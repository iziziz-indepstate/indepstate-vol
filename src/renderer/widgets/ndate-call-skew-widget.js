function findStartIndex(strikesAsc, baseStrike) {
  const exact = strikesAsc.findIndex((s) => s === baseStrike);
  if (exact !== -1) return exact;

  const aboveOrEqual = strikesAsc.findIndex((s) => s >= baseStrike);
  if (aboveOrEqual !== -1) return aboveOrEqual;

  return strikesAsc.length - 1;
}

function inferBaseStep(strikesAsc, startIdx) {
  const diffs = [];
  const from = Math.max(1, startIdx - 4);
  const to = Math.min(strikesAsc.length - 1, startIdx + 4);

  for (let i = from; i <= to; i += 1) {
    const diff = Math.abs(strikesAsc[i] - strikesAsc[i - 1]);
    if (Number.isFinite(diff) && diff > 0) diffs.push(diff);
  }

  if (!diffs.length) return 5;
  return Math.min(...diffs);
}

function pickStrikesFromChain(strikesAsc, baseStrike) {
  const selected = [];
  const startIdx = findStartIndex(strikesAsc, baseStrike);
  const anchor = strikesAsc[startIdx] ?? baseStrike;
  const step = inferBaseStep(strikesAsc, startIdx);

  const offsets = [5, 10, 15, 20, 25, 30, 35, 45, 55, 65];
  const used = new Set();

  for (const k of offsets) {
    const target = anchor + (step * k);
    const strike = strikesAsc.find((s) => s >= target);
    if (!Number.isFinite(strike) || used.has(strike)) continue;
    used.add(strike);
    selected.push(strike);
  }

  return selected;
}

export const nDateCallSkewWidget = {
  type: 'ndate-call-skew-line',
  mode: 'snapshot-series',
  defaultTitle: 'nDate-Call-Skew',
  color: '#ff7de3',
  defaultConfig: {
    baseStrike: 500,
    expiry: '',
    ticker: ''
  },
  buildSnapshotSeries: (snapshot, widget) => {
    const callByStrike = snapshot?.callBidIvByStrike || {};
    const strikesAsc = Array.isArray(snapshot?.callStrikesAsc)
      ? snapshot.callStrikesAsc
      : Object.keys(callByStrike).map(Number).filter(Number.isFinite).sort((a, b) => a - b);

    const configured = Number(widget?.config?.baseStrike);
    const baseStrike = Number.isFinite(configured) ? configured : 500;

    const selected = pickStrikesFromChain(strikesAsc, baseStrike);
    const points = selected.map((strike) => ({
      strike,
      bidIv: Number(callByStrike[strike])
    }));

    const labels = [];
    const values = [];

    for (let i = 1; i < points.length; i += 1) {
      const prev = points[i - 1];
      const curr = points[i];
      labels.push(String(curr.strike));

      if (!Number.isFinite(prev.bidIv) || !Number.isFinite(curr.bidIv)) {
        values.push(null);
      } else {
        values.push(curr.bidIv - prev.bidIv);
      }
    }

    return { labels, values };
  }
};
