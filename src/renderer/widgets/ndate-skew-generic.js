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

function normalizeSeries(labels, values, xOrder) {
  if (!Array.isArray(labels) || !Array.isArray(values) || labels.length !== values.length) {
    return { labels: [], values: [] };
  }

  const rows = labels.map((label, idx) => ({
    label: String(label),
    value: values[idx]
  }));

  rows.sort((a, b) => {
    const an = Number(a.label);
    const bn = Number(b.label);
    if (Number.isFinite(an) && Number.isFinite(bn)) {
      return xOrder === 'asc' ? an - bn : bn - an;
    }
    return xOrder === 'asc'
      ? a.label.localeCompare(b.label)
      : b.label.localeCompare(a.label);
  });

  return {
    labels: rows.map((x) => x.label),
    values: rows.map((x) => x.value)
  };
}

function computeSingleSeries(snapshot, widget, mapKey, side, direction, xOrder) {
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

  return normalizeSeries(labels, values, xOrder);
}

export function createNDateSkewWidget({ type, title, color, side, direction, xOrder = 'natural' }) {
  const mapKey = side === 'call' ? 'callBidIvByStrike' : 'putBidIvByStrike';

  return {
    type,
    mode: 'snapshot-series',
    defaultTitle: title,
    color,
    defaultConfig: {
      baseStrike: 500,
      expiryStart: '',
      expiryEnd: '',
      ticker: ''
    },
    buildSnapshotSeries: (snapshot, widget) => {
      if (snapshot?.byExpiry && typeof snapshot.byExpiry === 'object') {
        const entries = Object.entries(snapshot.byExpiry).sort((a, b) => a[0].localeCompare(b[0]));
        const computed = entries.map(([expiry, snap]) => ({
          expiry,
          ...computeSingleSeries(snap, widget, mapKey, side, direction, xOrder)
        })).filter((x) => x.labels.length > 0);

        if (!computed.length) return { labels: [], values: [] };

        const labelSet = new Set(computed.flatMap((x) => x.labels));
        const masterLabels = Array.from(labelSet).sort((a, b) => Number(a) - Number(b));
        if (xOrder !== 'asc') masterLabels.reverse();

        const palette = ['#7dffb3', '#7aa2ff', '#f97316', '#eab308', '#d946ef', '#06b6d4', '#ef4444'];
        const datasets = computed.map((series, idx) => {
          const byLabel = Object.fromEntries(series.labels.map((label, i) => [label, series.values[i]]));
          return {
            label: series.expiry,
            data: masterLabels.map((label) => (label in byLabel ? byLabel[label] : null)),
            borderColor: palette[idx % palette.length]
          };
        });

        return { labels: masterLabels, datasets };
      }

      return computeSingleSeries(snapshot, widget, mapKey, side, direction, xOrder);
    }
  };
}
