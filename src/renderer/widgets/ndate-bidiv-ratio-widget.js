function formatNumber(value, digits = 4) {
  if (!Number.isFinite(value)) return 'n/a';
  return Number(value).toFixed(digits);
}

function formatPercentFromRatio(ratio) {
  if (!Number.isFinite(ratio)) return 'n/a';
  const discountPct = (1 - ratio) * 100;
  return `${discountPct.toFixed(2)}%`;
}

function normalizeDistanceKey(distance) {
  return String(Math.round(distance * 1e6) / 1e6);
}

function resolveReferenceLevel(snapshot, widget) {
  const forward = Number(snapshot?.forward ?? snapshot?.fwd ?? snapshot?.F ?? snapshot?.f);
  if (Number.isFinite(forward)) return forward;

  const configured = Number(widget?.config?.baseStrike);
  if (Number.isFinite(configured)) return configured;

  const spot = Number(snapshot?.px ?? snapshot?.S);
  if (Number.isFinite(spot)) return spot;

  return null;
}

function filterByWidgetExpiry(entries, widget) {
  const start = String(widget?.config?.expiryStart || '').trim();
  const endRaw = String(widget?.config?.expiryEnd || '').trim();
  const end = endRaw || start;
  if (!start) return entries;

  return entries.filter(([expiry]) => expiry >= start && expiry <= end);
}

function buildSingleExpirySeries(expiry, snapshot, widget) {
  const reference = resolveReferenceLevel(snapshot, widget);
  if (!Number.isFinite(reference)) return { labels: [], values: [], pointMeta: [] };

  const putStrikes = Array.isArray(snapshot?.putStrikesAsc)
    ? snapshot.putStrikesAsc.filter((strike) => Number.isFinite(strike) && strike < reference)
    : [];
  const callStrikes = Array.isArray(snapshot?.callStrikesAsc)
    ? snapshot.callStrikesAsc.filter((strike) => Number.isFinite(strike) && strike > reference)
    : [];

  if (!putStrikes.length || !callStrikes.length) return { labels: [], values: [], pointMeta: [] };

  const callByDistance = new Map();
  for (const strike of callStrikes) {
    const distance = strike - reference;
    if (!Number.isFinite(distance) || distance <= 0) continue;
    callByDistance.set(normalizeDistanceKey(distance), strike);
  }

  const points = [];
  for (const putStrike of putStrikes) {
    const distance = reference - putStrike;
    if (!Number.isFinite(distance) || distance <= 0) continue;

    const callStrike = callByDistance.get(normalizeDistanceKey(distance));
    if (!Number.isFinite(callStrike)) continue;

    const putBid = Number(snapshot?.putBidByStrike?.[putStrike]);
    const putIv = Number(snapshot?.putIvByStrike?.[putStrike]);
    const callBid = Number(snapshot?.callBidByStrike?.[callStrike]);
    const callIv = Number(snapshot?.callIvByStrike?.[callStrike]);
    if (![putBid, putIv, callBid, callIv].every(Number.isFinite)) continue;
    if (putIv === 0 || callIv === 0) continue;

    const putBidIV = putBid / putIv;
    const callBidIV = callBid / callIv;
    if (!Number.isFinite(putBidIV) || !Number.isFinite(callBidIV) || callBidIV === 0) continue;

    const ratio = putBidIV / callBidIV;
    if (!Number.isFinite(ratio)) continue;

    points.push({
      distance,
      ratio,
      meta: {
        expiration: expiry,
        reference,
        putStrike,
        callStrike,
        putBid,
        putIv,
        callBid,
        callIv,
        putBidIV,
        callBidIV,
        ratio,
        discount: 1 - ratio
      }
    });
  }

  points.sort((a, b) => a.distance - b.distance);

  return {
    labels: points.map((point) => String(Math.round(point.distance * 1e6) / 1e6)),
    values: points.map((point) => point.ratio),
    pointMeta: points.map((point) => point.meta)
  };
}

function formatRatioTooltip(context) {
  const dataIndex = context?.dataIndex;
  const dataset = context?.dataset;
  const meta = dataset?.pointMeta?.[dataIndex];
  if (!meta) {
    const y = context?.parsed?.y;
    return `${dataset?.label || 'Ratio'}: ${Number.isFinite(y) ? y.toFixed(4) : 'n/a'}`;
  }

  return [
    `expiration: ${meta.expiration}`,
    `put strike: ${formatNumber(meta.putStrike, 3)}`,
    `call strike: ${formatNumber(meta.callStrike, 3)}`,
    `put bid: ${formatNumber(meta.putBid, 4)}`,
    `put IV: ${formatNumber(meta.putIv, 4)}`,
    `call bid: ${formatNumber(meta.callBid, 4)}`,
    `call IV: ${formatNumber(meta.callIv, 4)}`,
    `putBidIV: ${formatNumber(meta.putBidIV, 6)}`,
    `callBidIV: ${formatNumber(meta.callBidIV, 6)}`,
    `ratio: ${formatNumber(meta.ratio, 4)}`,
    `discount %: ${formatPercentFromRatio(meta.ratio)}`,
    `Put discount: ${formatPercentFromRatio(meta.ratio)}`
  ];
}

export const nDateSkewBidIVRatioWidget = {
  type: 'ndate-skew-bidiv-ratio-line',
  mode: 'snapshot-series',
  defaultTitle: 'nDate-Skew-BidIV-Ratio',
  color: '#f59e0b',
  defaultConfig: {
    baseStrike: 500,
    expiryStart: '',
    expiryEnd: ''
  },
  controls: {
    strike: true,
    expiryStart: true,
    expiryEnd: true,
    strikeInputType: 'number'
  },
  buildSnapshotSeries: (snapshot, widget) => {
    if (!snapshot?.byExpiry || typeof snapshot.byExpiry !== 'object') {
      return buildSingleExpirySeries(snapshot?.expiry || 'expiry', snapshot || {}, widget);
    }

    const entries = filterByWidgetExpiry(
      Object.entries(snapshot.byExpiry).sort((a, b) => a[0].localeCompare(b[0])),
      widget
    );

    const computed = entries
      .map(([expiry, snap]) => ({ expiry, ...buildSingleExpirySeries(expiry, snap, widget) }))
      .filter((series) => series.labels.length > 0);

    if (!computed.length) return { labels: [], values: [] };

    const labelSet = new Set(computed.flatMap((series) => series.labels));
    const masterLabels = Array.from(labelSet).sort((a, b) => Number(a) - Number(b));
    const palette = ['#7dffb3', '#7aa2ff', '#f97316', '#eab308', '#d946ef', '#06b6d4', '#ef4444'];

    const datasets = computed.map((series, idx) => {
      const byLabel = Object.fromEntries(series.labels.map((label, i) => [label, series.values[i]]));
      const metaByLabel = Object.fromEntries(series.labels.map((label, i) => [label, series.pointMeta[i]]));
      return {
        label: series.expiry,
        data: masterLabels.map((label) => (label in byLabel ? byLabel[label] : null)),
        pointMeta: masterLabels.map((label) => (label in metaByLabel ? metaByLabel[label] : null)),
        borderColor: palette[idx % palette.length],
        tooltipFormatter: formatRatioTooltip
      };
    });

    return { labels: masterLabels, datasets };
  }
};
