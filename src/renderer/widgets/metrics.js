export const skewMetrics = [
  {
    key: 'dAtm',
    name: 'ATM Call-Put Skew',
    compute: ({ atmPutIv, atmCallIv }) => {
      if (atmPutIv == null || atmCallIv == null) return null;
      return atmCallIv - atmPutIv;
    }
  },
  {
    key: 'dTail',
    name: '±3 Strike Put-Call Skew',
    compute: ({ putTailIv, callTailIv }) => {
      if (putTailIv == null || callTailIv == null) return null;
      return putTailIv - callTailIv;
    }
  }
];

export const skewMetricsByKey = Object.fromEntries(skewMetrics.map((m) => [m.key, m]));
