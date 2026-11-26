const ANY = '*';
const NOT_HIGH = ['LOW', 'NORMAL'];
const NOT_RISING = ['STABLE', 'FALLING'];
const NOT_FALLING = ['STABLE', 'RISING'];

export const REGIME_RULES = {
  version: 1,
  thresholds: { level: [-2, -1, 1, 2], momentum: [-0.5, 0.5], response: [-4, -3, 3, 4] },
  level: [
    ['VERY_LOW', 'Very low', 'Far below its historical average.'],
    ['LOW', 'Low', 'Below its historical average.'],
    ['NORMAL', 'Normal', 'Within the usual range around its historical average.'],
    ['ELEVATED', 'Elevated', 'Above its historical average.'],
    ['EXTREME', 'Extreme', 'Far above its historical average.']
  ],
  momentum: [
    ['FALLING', 'Falling', 'Falling relative to the typical size of changes at this horizon.'],
    ['STABLE', 'Stable', 'The change is within the configured range around zero.'],
    ['RISING', 'Rising', 'Rising relative to the typical size of changes at this horizon.']
  ],
  response: [
    ['EXTREME_RELIEF_RESPONSE', 'Extreme relief response', 'VIX moved far below the change expected for the observed SPX return.'],
    ['RELIEF_RESPONSE', 'Relief response', 'VIX moved below the change expected for the observed SPX return.'],
    ['NORMAL_RESPONSE', 'Normal response', 'The VIX response was within the model’s normal range.'],
    ['STRESS_RESPONSE', 'Stress response', 'VIX moved above the change expected for the observed SPX return.'],
    ['EXTREME_STRESS_RESPONSE', 'Extreme stress response', 'VIX moved far above the change expected for the observed SPX return.']
  ],
  // VIX, VIXEQ, COR1M.
  environment: [
    [['HIGH', 'HIGH', 'HIGH'], 'SYSTEMIC_STRESS', 'Systemic stress', 'Options price elevated volatility across individual stocks and the index, alongside high implied correlation.'],
    [['HIGH', ANY, 'HIGH'], 'SYSTEMIC_RISK', 'Systemic risk', 'Index volatility and implied correlation are elevated.'],
    [['HIGH', ANY, NOT_HIGH], 'INDEX_VOL_RISK', 'Index volatility risk', 'Index volatility is elevated with ordinary or low implied correlation.'],
    [[NOT_HIGH, 'HIGH', 'HIGH'], 'FRAGILE_INDEX', 'Fragile index', 'Single-stock volatility and implied correlation are elevated while index volatility remains within or below its usual range.'],
    [[NOT_HIGH, 'HIGH', NOT_HIGH], 'DISPERSION_RISK', 'Dispersion risk', 'Elevated volatility is concentrated in individual stocks.'],
    [[NOT_HIGH, NOT_HIGH, 'HIGH'], 'CORRELATION_RISK', 'Correlation risk', 'Options price elevated co-movement while volatility levels remain within or below their usual ranges.'],
    [['LOW', 'LOW', 'LOW'], 'CALM', 'Calm', 'Index volatility, constituent volatility and implied correlation are low.'],
    [[ANY, ANY, ANY], 'MIXED_NORMAL', 'Mixed or normal', 'Volatility and correlation levels show a mixed or ordinary risk environment.']
  ],
  diversification: [
    [['LOW', 'FALLING'], 'Improving', 'Already-low implied co-movement is falling, improving potential diversification among index constituents.'],
    [['LOW', 'STABLE'], 'Favorable', 'Low implied co-movement supports potential diversification among index constituents.'],
    [['LOW', 'RISING'], 'Starting to weaken', 'Implied co-movement remains low and is beginning to rise.'],
    [['NORMAL', 'FALLING'], 'Recovering', 'Implied co-movement is falling from a level within its usual range.'],
    [['NORMAL', 'STABLE'], 'Ordinary', 'Implied co-movement is stable and within its usual range.'],
    [['NORMAL', 'RISING'], 'Deteriorating', 'Implied co-movement is within its usual range and rising.'],
    [['HIGH', 'FALLING'], 'Partially recovering', 'Implied co-movement is falling and remains elevated.'],
    [['HIGH', 'STABLE'], 'Persistently reduced', 'Elevated implied co-movement continues to limit potential diversification among index constituents.'],
    [['HIGH', 'RISING'], 'Deteriorating further', 'Already-elevated implied co-movement is rising further.']
  ].map(([when, ...copy]) => [when, `DIVERSIFICATION_${when.join('_')}`, ...copy]),
  // VIXEQ, VIX, COR1M.
  stress: [
    [['RISING', 'RISING', 'RISING'], 'SYNCHRONIZED_VOL_EXPANSION', 'Synchronized volatility expansion', 'Stock and index volatility are rising alongside stronger implied co-movement.'],
    [[ANY, 'RISING', 'RISING'], 'SYSTEMIC_ESCALATION', 'Systemic escalation', 'Index volatility and implied co-movement are rising.'],
    [['RISING', NOT_RISING, NOT_RISING], 'DISPERSION_BUILDUP', 'Dispersion buildup', 'Stock volatility is rising while index volatility and implied co-movement are stable or falling.'],
    [['FALLING', 'RISING', NOT_RISING], 'INDEX_RISK_REPRICING', 'Index risk repricing', 'Index volatility is rising as stock volatility falls, with stable or falling implied co-movement.'],
    [[NOT_FALLING, 'FALLING', 'FALLING'], 'SYSTEMIC_RELIEF', 'Systemic relief', 'Index volatility and implied co-movement are falling while stock volatility is stable or rising.'],
    [['FALLING', 'FALLING', 'FALLING'], 'BROAD_NORMALIZATION', 'Broad normalization', 'Stock volatility, index volatility and implied co-movement are falling together.'],
    [['FALLING', NOT_RISING, 'STABLE'], 'CONSTITUENT_RELIEF', 'Constituent relief', 'Stock volatility is falling with stable co-movement and stable or falling index volatility.'],
    [['STABLE', 'STABLE', 'STABLE'], 'STABLE', 'Stable', 'All three momentum readings are in their stable ranges.'],
    [[ANY, ANY, ANY], 'MIXED_TRANSITION', 'Mixed transition', 'The volatility and correlation changes form a mixed pattern.']
  ],
  combined: [
    [['ORDINARY', 'STRESS'], 'EMERGING_STRESS', 'Emerging stress', 'VIX reacted unusually strongly in an ordinary or low risk environment.'],
    [['ELEVATED', 'STRESS'], 'ACUTE_STRESS', 'Acute stress', 'An unusually strong VIX response accompanies an elevated risk environment.'],
    [['ELEVATED', 'NORMAL'], 'ELEVATED_RISK_NORMAL_RESPONSE', 'Elevated risk / normal response', 'The VIX response is within the model’s normal range. The underlying risk environment remains elevated.'],
    [['ELEVATED', 'RELIEF'], 'ACUTE_RELIEF_ELEVATED_RISK', 'Acute relief / elevated risk', 'VIX reacted with unusual relief while the underlying risk environment remains elevated.'],
    [['ORDINARY', 'NORMAL'], 'NORMAL_MARKET', 'Normal market', 'An ordinary or low risk environment accompanies a VIX response within the model’s normal range.'],
    [['ORDINARY', 'RELIEF'], 'VOLATILITY_COMPRESSION', 'Volatility compression', 'VIX moved unusually far below the expected change in an ordinary or low risk environment.']
  ],
  ordinaryEnvironments: ['CALM', 'MIXED_NORMAL'],
  responseGroups: {
    EXTREME_STRESS_RESPONSE: 'STRESS', STRESS_RESPONSE: 'STRESS', NORMAL_RESPONSE: 'NORMAL',
    RELIEF_RESPONSE: 'RELIEF', EXTREME_RELIEF_RESPONSE: 'RELIEF'
  },
  unknown: ['UNKNOWN', 'Unknown', 'Required observations are unavailable or insufficient.'],
  implications: {
    CALM: ['Review risk against the standard risk budget.', 'Consider mean-reversion scenarios and check the cost of protection.'],
    DISPERSION_RISK: ['Monitor individual-stock risk.', 'Review relative strength and sector rotation.'],
    FRAGILE_INDEX: ['Monitor aggregate exposure.', 'Account for the sensitivity of index volatility to a spread of risk across constituents.'],
    SYSTEMIC_STRESS: ['Review aggregate risk and position sizing.', 'Review the risks of short volatility and averaging into positions.'],
    SYSTEMIC_ESCALATION: ['Review exposure to correlated positions.', 'Require independent evidence for countertrend setups.'],
    SYSTEMIC_RELIEF: ['Review whether the risk budget should remain constrained.', 'Assess whether volatility relief persists.'],
    BROAD_NORMALIZATION: ['Review risk constraints gradually.', 'Look for confirmation that ordinary trading conditions have returned.'],
    ACUTE_STRESS: ['Stress-test the portfolio.', 'Allow for wider ranges and weaker liquidity.'],
    ELEVATED_RISK_NORMAL_RESPONSE: ['Maintain controls appropriate for elevated risk.', 'Treat normal VIX response and underlying risk as separate inputs.']
  }
};
