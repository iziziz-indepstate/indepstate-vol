export const skewMetrics = [
  {
    key: 'dAtm',
    name: 'ATM Call-Put Skew',
    compute: ({ atmPutIv, atmCallIv }) => {
      if (atmPutIv == null || atmCallIv == null) return null;
      return atmCallIv - atmPutIv;
    }
  }
];

export const skewMetricsByKey = Object.fromEntries(skewMetrics.map((m) => [m.key, m]));
