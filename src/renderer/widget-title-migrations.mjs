const legacyTitles = new Map([
  ['zero-dte-skew', ['0DTE Skew', 'Skew. 0DTE']],
  ['multi-expiry-skew', ['Multi-Expiry Skew', 'Skew. Multi-Expiry']],
  ['atm-straddle', ['Straddle ATM', 'Straddle. ATM']],
  ['straddle-daily-price', ['Straddle Daily Price', 'Straddle. Daily Price']],
  ['straddle-dynamics', ['Straddle Dynamics', 'Straddle. Dynamics']],
  ['option-flow-tick', ['Option Flow TICK', 'Flow. TICK']],
  ['option-flow-balanced-tick', ['Option Flow Balanced TICK', 'Flow. Balanced TICK']],
  ['option-flow-gamma-flow', ['Option Flow Gamma Flow', 'Flow. Gamma Flow']],
  ['option-flow-gamma-imbalance', ['Option Flow Gamma Imbalance', 'Flow. Gamma Imbalance']],
  ['theblock-cme-btc-options', ['Volume and OI of CME Bitcoin Options', 'BTC. Volume and OI of CME Bitcoin Options']],
  ['theblock-btc-dvol-vol-of-vol', ['BTC DVol Index Vol of Vol', 'BTC. DVol Index Vol of Vol']],
  ['theblock-btc-dvol-variance-premium', ['BTC DVol Index Variance Premium', 'BTC. DVol Index Variance Premium']],
  ['theblock-btc-atm-iv', ['BTC ATM Implied Volatility', 'BTC. ATM Implied Volatility']],
  ['theblock-btc-option-skew-delta-5', ['BTC Option Skew Delta 5', 'BTC. Option Skew Delta 5']],
  ['theblock-btc-option-skew-delta-25', ['BTC Option Skew Delta 25', 'BTC. Option Skew Delta 25']]
]);

export function migrateWidgetTitles(tabs) {
  for (const tab of tabs || []) {
    for (const widget of tab?.widgets || []) {
      const titles = legacyTitles.get(widget?.type);
      if (titles && widget.title === titles[0]) widget.title = titles[1];
    }
  }
}
