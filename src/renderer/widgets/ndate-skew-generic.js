function findAnchorIndex(strikesAsc, baseStrike, direction) {
  const exact = strikesAsc.findIndex((s) => s === baseStrike);
  if (exact !== -1) return exact;

  if (direction === 'up') {
    const aboveOrEqual = strikesAsc.findIndex((s) => s >= baseStrike);
    return aboveOrEqual !== -1 ? aboveOrEqual : strikesAsc.length - 1;
  }

  for (let i = strikesAsc.length - 1; i >= 0; i -= 1) {
    if (strikesAsc[i] <= baseStrike) return i;
  }
  return 0;
}

function inferBaseStep(strikesAsc, anchorIdx) {
  const diffs = [];
  const from = Math.max(1, anchorIdx - 4);
  const to = Math.min(strikesAsc.length - 1, anchorIdx + 4);

  for (let i = from; i <= to; i += 1) {
    const diff = Math.abs(strikesAsc[i] - strikesAsc[i - 1]);
    if (Number.isFinite(diff) && diff > 0) diffs.push(diff);
  }

  return diffs.length ? Math.min(...diffs) : 5;
}

function pickStrikesFromChain(strikesAsc, baseStrike, direction) {
  const offsets = [5, 10, 15, 20, 25, 30, 35, 45, 55, 65];
  const used = new Set();

  if (!strikesAsc.length) return [];

  const anchorIdx = findAnchorIndex(strikesAsc, baseStrike, direction);
  const anchor = strikesAsc[anchorIdx] ?? baseStrike;
  const step = inferBaseStep(strikesAsc, anchorIdx);

  const selected = [];
  for (const k of offsets) {
    const target = direction === 'up'
      ? anchor + (step * k)
      : anchor - (step * k);

    const strike = direction === 'up'
      ? strikesAsc.find((s) => s >= target)
      : [...strikesAsc].reverse().find((s) => s <= target);

    if (!Number.isFinite(strike) || used.has(strike)) continue;
    used.add(strike);
    selected.push(strike);
  }

  return selected;
}

function safeStrikes(snapshot, side) {
  const key = side === 'call' ? 'callStrikesAsc' : 'putStrikesAsc';
  const mapKey = side === 'call' ? 'callBidIvByStrike' : 'putBidIvByStrike';
  const fromSnapshot = snapshot?.[key];
  if (Array.isArray(fromSnapshot)) return fromSnapshot;

  const strikeMap = snapshot?.[mapKey] || {};
  return Object.keys(strikeMap).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
}

export function createNDateSkewWidget({ type, title, color, side, direction }) {
  const mapKey = side === 'call' ? 'callBidIvByStrike' : 'putBidIvByStrike';

  return {
    type,
    mode: 'snapshot-series',
    defaultTitle: title,
    color,
    defaultConfig: {
      baseStrike: 500,
      expiry: '',
      ticker: ''
    },
    buildSnapshotSeries: (snapshot, widget) => {
      const ivByStrike = snapshot?.[mapKey] || {};
      const strikesAsc = safeStrikes(snapshot, side);
      const configured = Number(widget?.config?.baseStrike);
      const baseStrike = Number.isFinite(configured) ? configured : 500;

      const selected = pickStrikesFromChain(strikesAsc, baseStrike, direction);
      const points = selected.map((strike) => ({
        strike,
        bidIv: Number(ivByStrike[strike])
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
}
