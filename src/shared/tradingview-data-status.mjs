export function summarizeTradingViewModes(modes) {
  const updateModes = [...new Set(modes.map((mode) => String(mode || 'unknown')))];
  const delayed = updateModes.filter((mode) => /^delayed(?:_|$)/.test(mode));
  const delays = delayed.map((mode) => Number(mode.match(/_(\d+)$/)?.[1])).filter((value) => Number.isFinite(value) && value > 0);
  return {
    status: delayed.length ? 'delayed' : modes.length && updateModes.every((mode) => mode === 'streaming') ? 'realtime' : 'unknown',
    delaySeconds: delays.length ? Math.max(...delays) : null,
    updateModes
  };
}

export function tradingViewStatusNotice(snapshot) {
  const status = snapshot?.marketData;
  if (!status) return { level: 'neutral', text: 'TradingView: data mode not checked. Refresh the datasource to check.' };
  const observed = snapshot.time ? ` Last response: ${snapshot.time}.` : '';
  if (status.status === 'delayed') {
    const delay = status.delaySeconds > 0 ? ` (${status.delaySeconds / 60} min)` : '';
    return { level: 'warning', text: `Warning: TradingView options data is delayed${delay}. Real-time OPRA access was not applied to all returned contracts. Check tradingview.cookie in IS-VOL/config.json and your TradingView subscription.${observed}` };
  }
  if (status.status === 'realtime') {
    return { level: 'success', text: `TradingView: real-time data mode (streaming).${observed}` };
  }
  return { level: 'neutral', text: `TradingView: could not determine the data mode from this response. Real-time access is not confirmed.${observed}` };
}
