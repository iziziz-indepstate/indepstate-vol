function computeStrikeLadder(baseStrike) {
  const strikes = [];
  let current = baseStrike;

  for (let i = 0; i < 8; i += 1) {
    strikes.push(current);
    current -= 5;
  }

  current -= 10;
  strikes.push(current);
  current -= 10;
  strikes.push(current);

  return strikes;
}

export const nDatePutSkewWidget = {
  type: 'ndate-put-skew-line',
  mode: 'snapshot-series',
  defaultTitle: 'nDate-Put-Skew',
  color: '#7dffb3',
  defaultConfig: {
    baseStrike: 500
  },
  buildSnapshotSeries: (snapshot, widget) => {
    const putByStrike = snapshot?.putBidIvByStrike || {};
    const configured = Number(widget?.config?.baseStrike);
    const baseStrike = Number.isFinite(configured) ? configured : 500;

    const ladder = computeStrikeLadder(baseStrike);
    const points = ladder.map((strike) => ({
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
