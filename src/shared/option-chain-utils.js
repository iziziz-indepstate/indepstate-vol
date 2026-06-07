export function findStrikesAroundPrice(strikesSorted, price) {
  if (!Array.isArray(strikesSorted) || !strikesSorted.length || !Number.isFinite(price)) {
    return { lower: null, upper: null, lowerIdx: -1, upperIdx: -1 };
  }

  let lo = 0;
  let hi = strikesSorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (strikesSorted[mid] < price) lo = mid + 1;
    else hi = mid;
  }

  let upperIdx = lo < strikesSorted.length ? lo : -1;
  let lowerIdx = lo - 1 >= 0 ? lo - 1 : -1;

  if (upperIdx !== -1 && strikesSorted[upperIdx] === price) {
    lowerIdx = upperIdx;
    upperIdx = upperIdx + 1 < strikesSorted.length ? upperIdx + 1 : -1;
  }

  return {
    lower: lowerIdx !== -1 ? strikesSorted[lowerIdx] : null,
    upper: upperIdx !== -1 ? strikesSorted[upperIdx] : null,
    lowerIdx,
    upperIdx
  };
}

export function resolveStrikeSelection(strikesSorted, configuredStrike, underlyingPrice) {
  if (!Array.isArray(strikesSorted) || !strikesSorted.length) {
    return { strike: null, mode: 'empty-chain' };
  }

  const normalized = String(configuredStrike ?? '').trim().toUpperCase();
  if (normalized === 'ATM') {
    const { lower, upper } = findStrikesAroundPrice(strikesSorted, Number(underlyingPrice));
    if (lower == null && upper == null) return { strike: null, mode: 'atm' };
    if (lower == null) return { strike: upper, mode: 'atm' };
    if (upper == null) return { strike: lower, mode: 'atm' };

    const lowerDist = Math.abs(Number(underlyingPrice) - lower);
    const upperDist = Math.abs(upper - Number(underlyingPrice));
    return { strike: lowerDist <= upperDist ? lower : upper, mode: 'atm' };
  }

  const numeric = Number(configuredStrike);
  if (!Number.isFinite(numeric)) {
    return { strike: null, mode: 'invalid' };
  }

  if (strikesSorted.includes(numeric)) {
    return { strike: numeric, mode: 'exact' };
  }

  const nearest = strikesSorted.reduce((best, curr) => {
    if (!Number.isFinite(best)) return curr;
    return Math.abs(curr - numeric) < Math.abs(best - numeric) ? curr : best;
  }, Number.NaN);

  return { strike: Number.isFinite(nearest) ? nearest : null, mode: 'nearest' };
}

export function referencePriceFromSnapshot(snapshot) {
  const candidates = [
    snapshot?.px,
    snapshot?.S,
    snapshot?.spot,
    snapshot?.underlyingPrice,
    snapshot?.referencePrice
  ];
  for (const candidate of candidates) {
    const parsed = Number(candidate);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function normalizeStrikeConfig(value) {
  const normalized = String(value ?? '').trim();
  if (!normalized) return { kind: 'empty', value: null };
  if (normalized.toUpperCase() === 'ATM') return { kind: 'atm', value: 'ATM' };
  const numeric = Number(normalized);
  return Number.isFinite(numeric)
    ? { kind: 'numeric', value: numeric }
    : { kind: 'invalid', value: null };
}

export function resolveConfiguredStrike(strikesSorted, configuredStrike, options = {}) {
  const normalized = normalizeStrikeConfig(configuredStrike);
  const fallback = options.defaultStrike == null ? Number.NaN : Number(options.defaultStrike);

  if (normalized.kind === 'empty') {
    return {
      strike: Number.isFinite(fallback) ? fallback : null,
      mode: Number.isFinite(fallback) ? 'default' : 'empty'
    };
  }

  if (normalized.kind === 'atm') {
    return resolveStrikeSelection(
      strikesSorted,
      'ATM',
      options.underlyingPrice ?? referencePriceFromSnapshot(options.snapshot)
    );
  }

  if (normalized.kind === 'numeric') {
    return { strike: normalized.value, mode: 'numeric' };
  }

  return {
    strike: Number.isFinite(fallback) ? fallback : null,
    mode: Number.isFinite(fallback) ? 'default' : 'invalid'
  };
}
