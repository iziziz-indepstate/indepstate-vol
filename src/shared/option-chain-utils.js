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
