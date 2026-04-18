function findStartIndex(strikesDesc, baseStrike) {
  const exact = strikesDesc.findIndex((s) => s === baseStrike);
  if (exact !== -1) return exact;

  const belowOrEqual = strikesDesc.findIndex((s) => s <= baseStrike);
  if (belowOrEqual !== -1) return belowOrEqual;

  return 0;
}

function pickStrikesFromChain(strikesDesc, baseStrike) {
  const selected = [];
  const stepPattern = [5, 5, 5, 5, 5, 5, 5, 10, 10, 10];

  let idx = findStartIndex(strikesDesc, baseStrike);
  for (const step of stepPattern) {
    idx += step;
    if (idx >= strikesDesc.length) break;
    selected.push(strikesDesc[idx]);
  }

  return selected;
}

export const nDatePutSkewWidget = {
  type: 'ndate-put-skew-line',
  mode: 'snapshot-series',
  defaultTitle: 'nDate-Put-Skew',
  color: '#7dffb3',
  defaultConfig: {
    baseStrike: 500,
    expiry: '',
    ticker: ''
  },
  buildSnapshotSeries: (snapshot, widget) => {
    const putByStrike = snapshot?.putBidIvByStrike || {};
    const strikesDesc = Array.isArray(snapshot?.putStrikesDesc)
      ? snapshot.putStrikesDesc
      : Object.keys(putByStrike).map(Number).filter(Number.isFinite).sort((a, b) => b - a);

    const configured = Number(widget?.config?.baseStrike);
    const baseStrike = Number.isFinite(configured) ? configured : 500;

    const selected = pickStrikesFromChain(strikesDesc, baseStrike);
    const points = selected.map((strike) => ({
      strike,
      bidIv: Number(putByStrike[strike])
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
