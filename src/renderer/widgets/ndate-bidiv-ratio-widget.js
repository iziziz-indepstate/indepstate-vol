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

const DEFAULT_SR_PATTERN = [5, 5, 5, 10];
const DEFAULT_SR_POINTS = 10;

function normalizeStrikeRangeConfig(raw) {
  if (raw == null || raw === '') return { mode: 'pattern', pattern: DEFAULT_SR_PATTERN };

  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return { mode: 'count', count: Math.max(1, Math.floor(raw)) };
  }

  if (Array.isArray(raw)) {
    const pattern = raw
      .map((x) => Number(x))
      .filter((x) => Number.isFinite(x) && x > 0);
    return pattern.length
      ? { mode: 'pattern', pattern }
      : { mode: 'pattern', pattern: DEFAULT_SR_PATTERN };
  }

  const asText = String(raw).trim();
  if (!asText) return { mode: 'pattern', pattern: DEFAULT_SR_PATTERN };

  const numeric = Number(asText);
  if (Number.isFinite(numeric)) return { mode: 'count', count: Math.max(1, Math.floor(numeric)) };

  if (asText.startsWith('[') && asText.endsWith(']')) {
    try {
      const parsed = JSON.parse(asText);
      if (Array.isArray(parsed)) return normalizeStrikeRangeConfig(parsed);
    } catch {
      return { mode: 'pattern', pattern: DEFAULT_SR_PATTERN };
    }
  }

  return { mode: 'pattern', pattern: DEFAULT_SR_PATTERN };
}

function offsetsFromPattern(pattern, pointCount) {
  const out = [];
  let acc = 0;
  for (let i = 0; i < pointCount; i += 1) {
    const step = Number(pattern[i % pattern.length]);
    if (!Number.isFinite(step) || step <= 0) continue;
    acc += step;
    out.push(acc);
  }
  return out;
}

function inferBaseStep(reference, putStrikes, callStrikes) {
  const strikesAsc = Array.from(new Set([
    ...putStrikes,
    ...callStrikes,
    reference
  ])).filter(Number.isFinite).sort((a, b) => a - b);

  const anchorIdx = strikesAsc.findIndex((strike) => strike >= reference);
  const centerIdx = anchorIdx >= 0 ? anchorIdx : strikesAsc.length - 1;
  const from = Math.max(1, centerIdx - 4);
  const to = Math.min(strikesAsc.length - 1, centerIdx + 4);

  const diffs = [];
  for (let i = from; i <= to; i += 1) {
    const diff = Math.abs(strikesAsc[i] - strikesAsc[i - 1]);
    if (Number.isFinite(diff) && diff > 0) diffs.push(diff);
  }

  return diffs.length ? Math.min(...diffs) : 5;
}

function pickDistances(distancesAsc, reference, putStrikes, callStrikes, strikeRangeConfig) {
  const normalized = normalizeStrikeRangeConfig(strikeRangeConfig);
  if (normalized.mode === 'count') return distancesAsc.slice(0, normalized.count);

  const baseStep = inferBaseStep(reference, putStrikes, callStrikes);
  const offsets = offsetsFromPattern(normalized.pattern, DEFAULT_SR_POINTS);
  const selected = [];
  const used = new Set();

  for (const offsetSteps of offsets) {
    const targetDistance = baseStep * offsetSteps;
    const picked = distancesAsc.find((distance) => distance >= targetDistance && !used.has(normalizeDistanceKey(distance)));
    if (!Number.isFinite(picked)) continue;
    const key = normalizeDistanceKey(picked);
    used.add(key);
    selected.push(picked);
  }

  return selected;
}

function toFiniteOrNull(raw) {
  if (raw == null || raw === '') return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function resolveReferenceLevel(snapshot, widget) {
  const forwardCandidates = [snapshot?.forward, snapshot?.fwd, snapshot?.F, snapshot?.f]
    .map(toFiniteOrNull)
    .filter((value) => Number.isFinite(value) && value > 0);
  if (forwardCandidates.length) return forwardCandidates[0];

  const configured = toFiniteOrNull(widget?.config?.baseStrike);
  if (Number.isFinite(configured) && configured > 0) return configured;

  const spot = toFiniteOrNull(snapshot?.px ?? snapshot?.S);
  if (Number.isFinite(spot) && spot > 0) return spot;

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

  const candidatePoints = [];
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

    candidatePoints.push({
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

  candidatePoints.sort((a, b) => a.distance - b.distance);
  const candidateDistances = candidatePoints.map((point) => point.distance);
  const selectedDistances = pickDistances(candidateDistances, reference, putStrikes, callStrikes, widget?.config?.strikeRange);
  const selectedKeys = new Set(selectedDistances.map((distance) => normalizeDistanceKey(distance)));

  const points = candidatePoints.filter((point) => selectedKeys.has(normalizeDistanceKey(point.distance)));

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
    expiryEnd: '',
    strikeRange: ''
  },
  controls: {
    strike: true,
    expiryStart: true,
    expiryEnd: true,
    strikeRange: true,
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
