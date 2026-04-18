function findStartIndex(strikesAsc, baseStrike) {
  const exact = strikesAsc.findIndex((s) => s === baseStrike);
  if (exact !== -1) return exact;

  const aboveOrEqual = strikesAsc.findIndex((s) => s >= baseStrike);
  if (aboveOrEqual !== -1) return aboveOrEqual;

  return strikesAsc.length - 1;
}

function pickStrikesFromChain(strikesAsc, baseStrike) {
  const selected = [];
  const stepPattern = [5, 5, 5, 5, 5, 5, 5, 10, 10, 10];

  let idx = findStartIndex(strikesAsc, baseStrike);
  for (const step of stepPattern) {
    idx += step;
    if (idx >= strikesAsc.length) break;
    selected.push(strikesAsc[idx]);
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
