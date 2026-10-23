export const DATA_SOURCE_LABELS = {
  tradingview: 'TradingView',
  theblock: 'The Block',
  'tape-contract': 'Tape Contract'
};

export function defaultSourceConfig(providerKey, expiry = '') {
  const common = { pollSec: 5, keepPoints: 200, saveRawSnapshots: true, compactHistorySnapshots: true };
  if (providerKey === 'tradingview') return {
    ...common, apiBase: 'https://scanner.tradingview.com', ticker: 'AMEX:SPY',
    root: 'SPY', expiryStart: expiry, expiryEnd: '', yahooSymbol: 'SPY'
  };
  return providerKey === 'tape-contract' ? { ...common, root: 'SPY' } : common;
}

export function ensureDataSource(tab, providerKey, expiry = '') {
  if (!providerKey) return null;
  tab.dataSources ||= [];
  let source = tab.dataSources.find((item) => item.providerKey === providerKey);
  if (!source) {
    source = { id: `${tab.id}:source:${providerKey}`, providerKey, providerConfig: defaultSourceConfig(providerKey, expiry) };
    tab.dataSources.push(source);
  }
  return source;
}

export function normalizeTabDataSources(tab, getDefinition, expiry = '') {
  if (!Array.isArray(tab.dataSources)) {
    tab.dataSources = [];
    if (tab.providerKey) {
      const source = ensureDataSource(tab, tab.providerKey, expiry);
      source.providerConfig = { ...source.providerConfig, ...(tab.providerConfig || {}) };
      if (!tab.providerConfig?.expiryStart && tab.providerConfig?.expiry) source.providerConfig.expiryStart = tab.providerConfig.expiry;
    }
  }
  // Preserve the first configuration when recovering duplicate providers.
  const seen = new Set();
  tab.dataSources = tab.dataSources.filter((source) => {
    if (!source?.providerKey || seen.has(source.providerKey)) return false;
    seen.add(source.providerKey);
    source.id ||= `${tab.id}:source:${source.providerKey}`;
    const saved = source.providerConfig || {};
    source.providerConfig = { ...defaultSourceConfig(source.providerKey, expiry), ...saved };
    if (source.providerKey === 'tradingview' && !saved.expiryStart && saved.expiry) source.providerConfig.expiryStart = saved.expiry;
    return true;
  });
  for (const widget of tab.widgets || []) ensureDataSource(tab, getDefinition(widget.type)?.providerKey, expiry);
  if (!tab.dataSources.length && !(tab.widgets || []).length) ensureDataSource(tab, 'tradingview', expiry);
  delete tab.providerKey;
  delete tab.providerConfig;
  return tab;
}

export function sourceForWidget(tab, widget, getDefinition) {
  const providerKey = getDefinition(widget?.type)?.providerKey;
  return tab?.dataSources?.find((source) => source.providerKey === providerKey) || null;
}

export function sourceView(tab, source, getDefinition) {
  if (!tab || !source) return null;
  return {
    ...source, tabId: tab.id, title: `${tab.title} / ${DATA_SOURCE_LABELS[source.providerKey] || source.providerKey}`,
    widgets: (tab.widgets || []).filter((widget) => getDefinition(widget.type)?.providerKey === source.providerKey)
  };
}
