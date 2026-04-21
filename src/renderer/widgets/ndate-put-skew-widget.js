import { createNDateSkewWidget } from './ndate-skew-generic.js';

export const nDateSkewVelocityPutWidget = createNDateSkewWidget({
  type: 'ndate-skew-velocity-put-line',
  title: 'nDate-Skew-Velocity-Put',
  color: '#7dffb3',
  side: 'put',
  direction: 'down',
  xOrder: 'asc',
  computePointValue: (points, idx) => {
    const curr = points[idx];
    const next = points[idx + 1];
    if (!curr || !next) return undefined;
    if (!Number.isFinite(curr.bidIv) || !Number.isFinite(next.bidIv)) return null;
    return next.bidIv - curr.bidIv;
  }
});

export const nDateSkewPutWidget = createNDateSkewWidget({
  type: 'ndate-skew-put-line',
  title: 'nDate-Skew-Put',
  color: '#22c55e',
  side: 'put',
  direction: 'down',
  xOrder: 'asc',
  computePointValue: (points, idx) => {
    const curr = points[idx];
    if (!curr) return undefined;
    if (!Number.isFinite(curr.bidIv)) return null;
    return curr.bidIv;
  }
});
