import { findStrikesAroundPrice } from '../../shared/option-chain-utils.js';

function toNumberOrNull(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function findTailStrike(strikesSorted, anchorIdx, tailSteps, side) {
  if (!Array.isArray(strikesSorted) || !strikesSorted.length || anchorIdx == null || anchorIdx < 0) return null;
  const idx = side === 'put' ? anchorIdx - tailSteps : anchorIdx + tailSteps;
  if (idx < 0 || idx >= strikesSorted.length) return null;
  return strikesSorted[idx];
}

export const tailSkewWidget = {
  type: 'tail-skew-line',
  mode: 'timeseries-custom',
  chartRuntime: 'uplot',
  defaultTitle: 'Tail Put-Call Skew',
  color: '#ffb347',
  hideXAxisValues: true,
  controls: {
    tailSteps: true
  },
  defaultConfig: {
    tailSteps: 3
  },
  extractTimeSeriesValue: (snapshot, widget) => {
    const tailSteps = Math.max(1, Number(widget?.config?.tailSteps) || 3);
    const strikesSorted = Array.from(new Set([
      ...(Array.isArray(snapshot?.putStrikesAsc) ? snapshot.putStrikesAsc : []),
      ...(Array.isArray(snapshot?.callStrikesAsc) ? snapshot.callStrikesAsc : [])
    ])).sort((a, b) => a - b);

    const { lowerIdx, upperIdx } = findStrikesAroundPrice(strikesSorted, snapshot?.px);
    const putTailStrike = findTailStrike(strikesSorted, lowerIdx, tailSteps, 'put');
    const callTailStrike = findTailStrike(strikesSorted, upperIdx, tailSteps, 'call');
    if (!Number.isFinite(putTailStrike) || !Number.isFinite(callTailStrike)) return null;

    const putTailIv = toNumberOrNull(snapshot?.putBidIvByStrike?.[putTailStrike]);
    const callTailIv = toNumberOrNull(snapshot?.callBidIvByStrike?.[callTailStrike]);
    if (putTailIv == null || callTailIv == null) return null;
    return putTailIv - callTailIv;
  }
};
