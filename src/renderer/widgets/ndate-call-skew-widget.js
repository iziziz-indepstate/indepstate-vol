import { createNDateSkewWidget } from './ndate-skew-generic.js';

export const nDateSkewVelocityCallWidget = createNDateSkewWidget({
  type: 'ndate-skew-velocity-call-line',
  title: 'nDate-Skew-Velocity-Call',
  color: '#ff7de3',
  side: 'call',
  direction: 'up',
  xOrder: 'asc',
  computePointValue: (points, idx) => {
    const curr = points[idx];
    const next = points[idx + 1];
    if (!curr || !next) return undefined;
    if (!Number.isFinite(curr.bidIv) || !Number.isFinite(next.bidIv)) return null;
    return next.bidIv - curr.bidIv;
  }
});

export const nDateSkewCallWidget = createNDateSkewWidget({
  type: 'ndate-skew-call-line',
  title: 'nDate-Skew-Call',
  color: '#ec4899',
  side: 'call',
  direction: 'up',
  xOrder: 'asc',
  computePointValue: (points, idx) => {
    const curr = points[idx];
    if (!curr) return undefined;
    if (!Number.isFinite(curr.bidIv)) return null;
    return curr.bidIv;
  }
});
