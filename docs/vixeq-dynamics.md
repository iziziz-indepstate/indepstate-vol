# VIX. VIXEQ Dynamics

`VIX. VIXEQ Dynamics` shows daily implied volatility for S&P 500 constituents and the index alongside one-month implied correlation. The overview uses the last completed session in the selected range. Hover over a panel to locate the same session across all three panels.

The spread is `VIXEQ − VIX` in volatility points. Switch the spread panel to **5-session contributions** to see `+ΔVIXEQ` and `−ΔVIX` as bars and their sum as a marker. A narrower spread can reflect a higher VIX, a lower VIXEQ, or both. The summary describes the five-session move and reports the direction of COR1M separately.

Each widget saves its spread chart view, `level` or `contributions`, as `spreadView`.

The line below the summary explains how expected moves changed for individual stocks and the index. It also describes whether options imply stronger, weaker, or unchanged co-movement among stocks. Each part uses the available five-session changes.

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
| `series`, `latest` | Dated rows and the last completed session row, respectively. A row contains `date`, `vixeq`, `vix`, `spread`, `cor1m`, `change5`, `change20`, `zScore` and `retrospective`. Changes use the four level keys. Z-scores use `vixeq` and `spread`. Missing numeric values are `null`. |
| `sources` | Metadata by `vixeq`, `vix` and `cor1m`, including the requested and actual providers, last close date, retrieval time and cache status. |
| `summary`, `warnings`, `error` | Five-session description, source messages and an error message when the load fails. |
