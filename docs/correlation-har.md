# COR. Correlation HAR

`COR. Correlation HAR` is an independent widget. Add it from the dashboard widget picker; no TradingView or other datasource is required. It forecasts realized correlation over the next **21 SPX sessions** and records predictions actually issued by this application. It does not run a historical backtest.

## Model

```text
Forecast(t) = intercept + beta5 * RC5(t) + beta10 * RC10(t)
             + beta21 * RC21(t) + betaEWMA * EWMA10(t)
```

RC uses the [COR. Realized Correlation](realized-correlation.md) formula, synchronized daily log returns and adjusted stock closes. EWMA10 uses a half-life of 10 sessions and up to 100 consecutive returns. The specification is a HAR-style adaptation, not the original HAR-RV volatility model.

For a training origin `s`, the target is RC calculated directly from returns in sessions `s+1 … s+21`. It is **not** the average of subsequent rolling RC21 values. At forecast date `t`, only targets ending on or before `t` are eligible. Select the latest 1260 complete examples, with a minimum of 504, after factor warmup. The loader obtains additional prices for warmup and forward labels; the required download therefore exceeds five calendar years.

Coefficients are estimated with ordinary least squares using centered, standardized factors and pivoted QR with reorthogonalization. Rank-deficient factors, insufficient training history and incomplete latest factors prevent a new forecast. Coefficients are re-estimated for each newly issued forecast; COR1M is not a regressor. Predictions are not clipped. A prediction outside −100…100 points is flagged explicitly.

The current Top 50 IVV equities and their normalized current weights are applied to the entire training history. This introduces historical constituent-selection bias. The model is an approximation to correlation of this basket, rather than a reconstruction of historical Cboe baskets. The horizon of 21 trading sessions also only approximates COR1M's monthly tenor. `Forecast − COR1M` is a comparison in correlation points, not an estimated trading return.

## Display and forward tracking

Summary cards show HAR Forecast 21D, COR1M at issuance, their difference, RC21 and EWMA10. The widget also shows the data session, actual issuance timestamp, basket date, training count, source checks and warnings. Model details expose coefficients, training origins, last known target date and the storage directory.

The chart plots forecasts, COR1M at origin and subsequent facts against the **forecast origin date**. A single archived prediction is displayed as a point. The tooltip includes actual issuance time, target end date when known, and `Forecast − Fact`. Pending facts and errors remain null; they are not zeroes.

Each forecast saves its original basket and weights. After exactly 21 subsequent SPX sessions, the service calculates the outcome using that original basket, even if a ticker has since left the current Top 50. Missing prices or zero pairwise risk leave the outcome pending. Price gaps in mature target windows are retried on subsequent updates. A completed outcome is frozen once recorded.

The first forecast saved for a session is immutable, including its issuance-time COR1M, which can be unavailable. Updates may add an outcome but do not rewrite the forecast, coefficients or original basket. No predictions are created for missed historical sessions. After a period with the app closed, only the latest available completed session is forecast; existing pending outcomes can still be completed.

## Updates and disk storage

The main process checks at startup and every 15 minutes while a HAR widget exists on **any** dashboard tab. Selecting another tab does not stop recording. Removing the last instance stops future scheduled checks. Visible widgets check the shared service state once a minute; dashboard polling does not trigger model training. Multiple instances share one service and archive.

Sessions use the existing conservative cutoff of **16:15 America/New_York**, including early-close days. SPX observations establish actual session dates. The existing US holiday calendar and weekends establish the expected last completed session: if SPX is delayed, the service waits rather than issuing a historical forecast. Stock data must include that session; failed/stale price refreshes cannot issue a new prediction. Failed refreshes retain the previously saved archive with its original dates and explicit partial/error status. COR1M failure alone does not block issuance.

**Update data** checks the sources immediately. It does not replace a forecast already recorded for the session. Initial loading can take several minutes, with at most four simultaneous stock-history requests and a 20-second timeout per fetch. Numerical work runs in a worker thread.

Storage root: `Documents/IS-VOL/Data/Correlation-HAR`:

- `histories/`: adjusted Yahoo stock prices, SPX dates and Cboe COR1M, with requested coverage and last successful check time.
- `holdings.json`: the latest dated iShares basket, normally checked once per 24 hours.
- `forecasts.json`: versioned issued predictions and their individual basket snapshots, sources and outcomes.

The first load requests the full required history. Later loads merge by date, request newly needed history and refresh an overlap of 21 prior returns (22 closes). If adjusted prices change in that overlap, the necessary history of that ticker is reloaded to avoid mixing adjustment bases. Mature outcome gaps can extend the refresh interval. Cboe serves a complete CSV, so its download cannot be restricted to incremental rows. Arbitrary revisions outside the overlap are not automatically detected.

Writes use temporary files and atomic rename. The immutable forecast archive is not a disposable cache: invalid JSON or an invalid schema stops updates rather than overwriting it. A failed archive commit does not publish an unsaved prediction. Histories remain independent of the existing COR. Realized Correlation widget's cache.

## IPC and widget output

`appBridge.getCorrelationHarState({ refresh?: boolean })` uses `market-data:get-correlation-har-state` and returns:

```text
type: 'correlation-har'
status: 'ok' | 'partial' | 'error'
latest: issued forecast | null
records: issued forecasts ordered by data session
latestSession: latest confirmed SPX data session | null
checkedAt, directory, sources, warnings, error
```

Each record contains `date`, `issuedAt`, `forecast`, `cor1m`, `spread`, `factors`, `coefficients`, `training`, `model`, `basket`, `basketAsOf`, `sources`, `basketMode`, `priceMode`, `targetEndDate`, `fact`, `error` and `warnings`. Model version 1 fixes the horizon at 21, EWMA half-life at 10, and training limits at 504–1260 samples. `targetEndDate` remains null until the full forward session window exists; it may be known while missing component data still prevents a fact.

The renderer publishes this state through the existing widget-data bus, with widget title and configuration. No additional MCP endpoint is necessary. RMS experiments, confidence intervals, parameter tuning, backtests and automated trading signals are outside this version.
