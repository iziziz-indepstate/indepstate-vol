# VIX. VIXEQ Dynamics

`VIX. VIXEQ Dynamics` shows daily implied volatility for S&P 500 constituents and the index alongside one-month implied correlation. The overview uses the last completed session in the selected range. Hover over a panel to locate the same session across all three panels.

The spread is `VIXEQ − VIX` in volatility points. Switch the spread panel to **5-session contributions** to see `+ΔVIXEQ` and `−ΔVIX` as bars and their sum as a marker. A narrower spread can reflect a higher VIX, a lower VIXEQ, or both. The summary describes the five-session move and reports the direction of COR1M separately.

Each widget saves its spread chart view, `level` or `contributions`, as `spreadView`.

The line below the summary explains how expected moves changed for individual stocks and the index. It also describes whether options imply stronger, weaker, or unchanged co-movement among stocks. Each part uses the available five-session changes.

## Market Regime

The top panel classifies the last completed session in the selected range. It covers the risk environment, potential diversification among index constituents, five- and twenty-session stress dynamics, the VIX response and their combined state. Use the numbers and tooltips to see the observations behind each classification. Click **Market Regime** to collapse or expand the panel. Each widget saves its own panel state. The rules and English descriptions are versioned in `src/shared/volatility-regime-rules.mjs`.

Add **VIX. Response** to the same tab to include Risk Response and Combined Market State. With one instance, the panel links it automatically. With several, select an instance in the panel. The saved `config.responseWidgetId` identifies that instance. Its published result must include the exact session. When the response is unavailable, both dependent states show **Unknown** and the independent states remain visible.

The level classification measures each metric against the previous 252 trading sessions. Momentum divides the current five- or twenty-session change by the population standard deviation of the previous 252 valid changes at the same horizon. The calculation extends the history as needed and uses session offsets even where closes are missing. Diversification uses the COR1M level and twenty-session momentum. Stress dynamics use VIXEQ, VIX and COR1M. The spread remains visible as context.

Risk Response uses the standardized residual from the [VIX. Response model](vix-response.md). The combined state distinguishes a response within the model’s typical range from a return to ordinary underlying risk. Thresholds and trading considerations are configurable heuristics. Directional bias is always **Undetermined**.

## Calculation and data

- Changes compare closes five or twenty trading sessions apart. Missing endpoints leave the affected change empty. Spread levels require both closes on the same date.
- The chart tooltip shows Z-scores for VIXEQ and the spread. Each uses the mean and population standard deviation of the 252 prior trading sessions, excluding the current observation. An incomplete window or zero standard deviation leaves the Z-score empty.
- The default display range is three calendar months, with a conservative U.S. session cutoff of 16:15 New York time, including early-close days. An earlier end date is supported. The initial lookback is loaded separately from the visible dates.
- The default sources are [Cboe VIXEQ](https://cdn.cboe.com/api/global/us_indices/daily_prices/VIXEQ_History.csv), [Cboe VIX](https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv) and [Cboe COR1M](https://cdn.cboe.com/api/global/us_indices/daily_prices/COR1M_History.csv). For VIX, the standard market-data fallback providers are also supported. Each source retains its own closing time. Gaps remain visible, and the widget identifies the provider, its last available close and cache status.
- Enter a path under **VIXEQ local CSV** to use a file in place of the remote VIXEQ series. Include the `date,close` header and one positive close per trading date. Clear the path to restore the Cboe source. **Refresh** reloads configured sources.
- Shading and hover text identify historical VIXEQ observations before its November 4, 2024 launch. [Cboe and S&P DJI methodology](https://www.spglobal.com/spdji/en/documents/methodologies/methodology-cboe-sp-500-dispersion-index.pdf)

## IPC and widget output

`appBridge.getVixeqDynamics({ startDate?, endDate?, vixeqLocalSource?, forceRefresh? })` returns the result. The widget publishes it with its `type`, `title` and saved `config`.

| Field | Description |
| --- | --- |
| `status` | `ok` for complete displayed closes, `partial` when useful data remains with gaps or stale cache, `error` when no closes are available to show. |
| `startDate`, `endDate` | Inclusive effective display bounds in `YYYY-MM-DD` format. |
| `series`, `latest` | Dated rows and the last completed session row, respectively. A row contains `date`, `vixeq`, `vix`, `spread`, `cor1m`, `change5`, `change20`, `zScore` and `retrospective`. Changes and Z-scores use the four level keys. Missing numeric values are `null`. |
| `sources` | Metadata by `vixeq`, `vix` and `cor1m`, including the requested and actual providers, last close date, retrieval time and cache status. |
| `regimeObservations` | Prior-window counts and standard deviations for the latest row, under `levels`, `momentum[5]` and `momentum[20]`, keyed by metric. |
| `regime` | Renderer-published result with `schema_version`, `rules_version`, `as_of_date`, `risk_environment`, `metric_levels`, `extreme_metric_flags`, `diversification_state`, `stress_dynamics_5d`, `stress_dynamics_20d`, `risk_response`, `combined_state`, `directional_bias`, `risk_management_implications`, `strategy_considerations`, `matched_rule_ids` and `data_quality`. Each state has `id`, `label`, `description` and `supporting_metrics`. |
| `summary`, `warnings`, `error` | Five-session description, source messages and an error message when the load fails. |
