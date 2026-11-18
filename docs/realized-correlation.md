# Realized Correlation

`Realized Correlation` is an independent widget with its own daily market data. Add it from the dashboard widget picker; it does not require a TradingView, The Block, or Tape Contract datasource.

## Display and controls

The main chart plots RC5, RC10, RC21, RC EWMA and Cboe COR1M in correlation points (correlation multiplied by 100). The second chart plots `COR1M − RC21`, with a zero reference. Values can be negative. The summary shows the latest session's values, without replacing missing values with older observations.

The default period is one year ending at the latest available completed session. Blank Start/End fields retain these rolling defaults. Dates select the displayed interval. Checkboxes persist line visibility, including the EWMA line, which is enabled by default. Visibility changes reuse the loaded data, including when disk caching is disabled.

**EWMA half-life (sessions)** accepts integers from 1 to 63, defaulting to 10. The label `RC EWMA · H=10` identifies the selected half-life. Changing it recalculates the line and checks cache coverage for the required warmup; it does not force a download if a fresh covering cache already exists. Existing widget configurations automatically use H=10 with EWMA enabled. Invalid interactive edits are rejected; malformed saved half-lives recover to 10.

Loading includes at least `max(21, 10 × H)` prior SPX session closes for warmup. The loader starts with a calendar-day buffer, checks actual session coverage and expands the range if necessary, stopping after four attempts or when no earlier observations appear. Unavailable full warmup is reported explicitly. Changing the displayed start date does not change overlapping EWMA values once both loads have the full warmup and identical source data.

Data loads on opening the widget and changing the period or cache setting. **Load data** bypasses the fresh cache and refreshes sources. Dashboard polling does not trigger another load. Closing a widget or switching tabs destroys its charts and invalidates pending rendering.

## Sources and approximation

- Holdings: [iShares IVV latest holdings CSV](https://www.ishares.com/us/products/239726/ishares-core-s-p-500-etf/latest-holdings.csv). Select the 50 largest equity positions by Market Weight and normalize their weights to sum to one. Cash and derivatives are excluded; separate share classes remain separate equities.
- Stock histories: Yahoo daily **adjusted close**, including Yahoo's corporate-action adjustments. Raw closes are not substituted when adjusted data is unavailable. Share-class ticker dots are translated to Yahoo hyphens.
- Session dates: Yahoo SPX (`^GSPC`) daily history, also used to detect missing stock observations.
- Implied correlation: [Cboe COR1M daily history](https://cdn.cboe.com/api/global/us_indices/daily_prices/COR1M_History.csv).

This is the realized correlation of **today's Top 50 IVV basket with fixed current weights over the entire displayed history**. The holdings date and basket are available in the widget. Historical selection/weight changes are not reconstructed, so the series has selection/look-ahead bias when used for historical research. IVV holdings and adjusted total-return prices also differ from the exact [Cboe methodology](https://www.cboe.com/us/indices/implied/). The spread compares forward implied expectations with trailing realization; it is not a measured future correlation risk premium.

Observations for the current New York date are excluded until 16:15 America/New_York. This conservative cutoff applies even on early-close days. The data remains end-of-day, rather than live intraday correlation.

## Calculation

For each stock, calculate `r[i,t] = ln(P[i,t] / P[i,t−1])`. Each rolling window contains exactly 5, 10, or 21 consecutive observed SPX sessions. Calculate sample covariance `Σ` after subtracting each stock's window mean, using `N−1` as the divisor. With normalized weights `w`:

```text
individual = sum(w[i]^2 * Σ[i,i])
riskSum = sum(w[i] * sqrt(Σ[i,i]))
RC = 100 * (wᵀΣw − individual) / (riskSum^2 − individual)
```

Annualization cancels from this ratio. The implementation computes the weighted basket-return variance, which is equivalent to `wᵀΣw`, avoiding a full covariance matrix. It is also equivalent to the volatility-and-capitalization weighted average of pairwise correlations.

A return requires a finite positive price for all 50 stocks on both adjacent SPX dates. A missing observation invalidates affected windows; dates are never compressed, prices are never forward-filled, and stocks are never silently removed. Zero pairwise risk produces `null`. COR1M and the spread require an exact same-date match. If there is no valid RC window anywhere in the requested period, the widget reports an error.

### EWMA correlation

EWMA uses the same synchronized stock returns and fixed basket weights. It is a weighted covariance estimate of returns, not a moving average of RC21 and not a fitted forecast.

For half-life `H`, set `lambda = 2^(−1/H)`. A return `k` sessions old has weight proportional to `lambda^k`, so its weight halves every H sessions. Normalize temporal weights to sum to one, subtract each stock's weighted mean, and calculate weighted variances of each stock and the basket. Insert these variances into the same RC formula above. A common covariance bias correction would cancel from the correlation ratio, so none is applied.

The finite history length is `L = max(21, 10 × H)` returns. At ten half-lives, less than 0.1% of infinite-history weight lies outside the lookback. The implementation retains up to L consecutive complete returns and starts publishing after 21. Before full L-history is available, weights are normalized over available observations. A missing component price clears the EWMA sequence; output remains null until 21 new consecutive complete returns are available. Zero pairwise risk also produces null. All inputs are at or before the plotted date.

The published `ewma` metadata describes the half-life, decay factor, maximum lookback, minimum observations and centered-covariance method. The existing spread continues to use RC21.

## Loading and failures

The main process limits downloads to four at a time, shares identical concurrent requests, and applies a 20-second timeout to each HTTP request. Public endpoints require no configured API key but can fail or rate-limit requests.

Holdings and price histories are cached for 24 hours under Electron `userData/realized-correlation-cache`. Cache coverage records requested ranges, including weekends and holidays with no rows. A covering cache can be used after a failed refresh, with its original timestamp and an explicit warning. Disabling Cache disables both disk reads and writes. These caches are separate from the raw-close histories used by SPX IV / RV.

An unavailable stock without a covering cache fails the load and identifies its ticker. A missing COR1M source preserves RC and produces a partial result. Source warnings, cache state and timestamps are included in the published dataset.

## IPC and published output

`appBridge.getRealizedCorrelationInputs({ startDate?, endDate?, cache?, forceRefresh?, ewmaHalfLife? })` returns the effective display range, validated `ewmaHalfLife`, dated holdings/basket, SPX calendar, adjusted histories by ticker, optional COR1M history, and warnings. Omitted half-life defaults to 10; invalid explicit values reject before loading. Each history includes `bars`, provider/cache metadata and its last successful retrieval timestamp.

The widget publishes through the existing widget data store and is available through MCP `get_widget_data` after its dashboard tab renders:

```ts
{
  type: 'realized-correlation',
  status: 'ok' | 'partial' | 'error',
  title: string,
  config: object, // Includes ewma: boolean and ewmaHalfLife: number.
  basket?: Array<{ symbol: string, name: string, indexWeight: number, weight: number }>,
  basketAsOf?: string,
  basketMode?: 'current-fixed-weights',
  priceMode?: 'adjusted',
  startDate?: string,
  endDate?: string,
  sources?: { holdings: object, calendar: object, prices: object, cor1m: object | null },
  series?: Array<{ date: string, rc5: number | null, rc10: number | null,
    rc21: number | null, rcEwma: number | null, cor1m: number | null, spread: number | null }>,
  ewma?: { halfLife: number, lambda: number, lookbackSessions: number,
    minObservations: 21, method: 'exponentially-weighted-centered-covariance' },
  latest?: object,
  latestSpxDate?: string,
  latestCor1mDate?: string | null,
  warnings?: string[],
  error?: string
}
```

`partial` means the latest session lacks RC21, RC EWMA or matching COR1M, or COR1M failed to load. Hiding EWMA does not remove it from the dataset or change its status. Earlier gaps remain explicit nulls in the series. Errors publish a new error contract rather than retaining an old successful result.
