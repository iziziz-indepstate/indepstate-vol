import { createNDateSkewWidget } from './ndate-skew-generic.js';

export const nDateCallSkewWidget = createNDateSkewWidget({
  type: 'ndate-call-skew-line',
  title: 'nDate-Call-Skew',
  color: '#ff7de3',
  side: 'call',
  direction: 'up',
  xOrder: 'asc'
});
