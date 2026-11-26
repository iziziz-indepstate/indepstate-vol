# VIX. Response

`VIX. Response` (`vix-response`) is a standalone widget that compares the actual daily VIX change with the response estimated for the observed SPX move. A positive residual means VIX rose more or fell less than expected. For example, an actual change of +3.50 points and an expected change of +2.00 points give a residual of +1.50 points.

## Calculation and data

For each completed US trading session, compute the SPX close-to-close return in percent and the VIX close-to-close change in points. Fit `VIX change = alpha + beta × SPX return` by ordinary least squares on the 60 immediately preceding sessions, then apply it to the observed SPX return for the session being evaluated. The residual is actual minus expected. The result measures a same-day deviation from a historical baseline. Several factors can contribute to the same residual.

Use `Start date` and `End date` to set the inclusive display range. With both fields blank, the widget shows the latest three calendar months. A blank start date means three months before the effective end, and a blank end date means the latest completed date. The end is limited by the 16:15 New York time cutoff, including early-close days. VIX history starts in January 1990. The selected providers may have shorter histories.

The widget requests additional closes before the display range so the first visible session can use its full 60-session training window. It uses the US market calendar and aligns daily closes by trading date. Each source uses its own closing time. A missing close leaves gaps in changes and in subsequent model windows that depend on it. An incomplete training window or constant SPX returns leave the expected change and residual empty.

The residual chart draws rolling ±3σ bounds in purple and ±4σ bounds in red. For each date, σ is the root mean square of the 60 training errors from that date's regression. The intercept centers these errors at zero. The bounds depend on the training window, so changing the display range leaves the bounds on overlapping dates unchanged when the same source data is available. Missing training data leaves a gap. The bounds can still appear if the current session's close is unavailable.

Choose Yahoo or FRED for SPX and Cboe, Yahoo or FRED for VIX. Yahoo and Cboe are selected by default. The widget saves the selection and loads the newly selected history as soon as a selection changes. `Refresh` requests both selected sources again. [Yahoo SPX](https://finance.yahoo.com/quote/%5EGSPC/history/) · [FRED SPX](https://fred.stlouisfed.org/series/SP500) · [Cboe VIX](https://www.cboe.com/tradable_products/vix/vix_historical_data) · [Yahoo VIX](https://finance.yahoo.com/quote/%5EVIX/history/) · [FRED VIX](https://fred.stlouisfed.org/series/VIXCLS)

The widget uses the same daily provider service as `SPX IV / RV`. In Hybrid mode, a failed request uses the provider's available cache. With no cache available, the service tries the next provider in its fallback chain. The widget shows which provider supplied each series. If the returned history stops before the last completed session in the display range, the summary leaves that session's figures blank and the charts show the available history.

The standardized residual divides the same-session residual by the prior training error σ. It is empty when the residual is unavailable or σ is zero. The Market Regime panel consumes this daily value.

## IPC and widget output

`appBridge.getVixResponse({ spxProvider?, ivProvider?, startDate?, endDate?, forceRefresh? })` returns the calculation result. The widget publishes it with its `type`, `title` and `config`, including the provider selections and saved date fields.

| Field | Description |
| --- | --- |
| `status` | `ok` when the latest residual is available from current data, `partial` when a usable residual history remains with a missing latest result or stale cache, or `error` when no residual can be calculated. |
| `startDate`, `endDate` | Effective inclusive display bounds as `YYYY-MM-DD`. |
| `latest` | Last completed session in the display range, even if values are missing. `null` if the range has no sessions or loading failed before the session could be determined. |
| `series` | Display rows in ascending order, each with `date`, `spxReturn`, `actualChange`, `expectedChange`, `residual`, `standardizedResidual`, `coefficients` (`alpha`, `beta`) and `residualBands`. Unavailable values are `null`. |
| `residualBands` | The last session's `residualBands`, or `null` if the model could not be fitted. Each row's band object has `count` (60), `mean` (0), `sigma`, `lower` (−3σ) and `upper` (+3σ). The chart also plots ±4σ. |
| `model` | `method`, `windowSessions`, `spxReturnUnit` and `vixChangeUnit`. |
| `sources` | Metadata keyed by `spx` and `vix` with `requestedProvider`, actual `provider` (or `null`), `fallback`, `latestDate`, `updatedAt`, `cached` and `stale`. |
| `warnings`, `error` | Source availability, cache or model messages. `error` is present when `status` is `error`. |
