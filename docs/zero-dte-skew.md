# 0DTE Skew

`0DTE Skew` plots three intraday series for one expiration, using the current tab's TradingView snapshots:

- **Skew25** = put IV at −25 delta minus call IV at +25 delta. Positive values mean the put wing has higher IV.
- **Put25 − ATM** = put IV at −25 delta minus ATM IV.
- **Call25 − ATM** = call IV at +25 delta minus ATM IV.

The shared axis uses volatility points: 24% put IV minus 21% call IV is **+3 vol pts**. A dashed horizontal line marks zero. Click legend entries to toggle series. Hover to inspect the source IVs, ATM strike, and contracts used for interpolation.

## Controls

- `D`: symmetric absolute target delta for both sides, from `0.01` to `0.49`; default `0.25`. Labels and the chart title follow this setting.
- `Exp`: `today` by default, resolved from each snapshot's calendar date in `America/New_York`. An explicit `YYYYMMDD` or `YYYY-MM-DD` selects a fixed expiration. Empty input behaves as `today`.

The expiration must already exist in the tab's provider snapshots. The widget does not fetch additional chains or fall back to a later expiration. Separate sessions and expirations are separated by gaps.

## Calculation and missing data

Each side uses strictly OTM contracts relative to the snapshot's underlying price. IV is linearly interpolated in absolute delta between the closest valid contracts bracketing the target; an exact delta match uses one contract. There is no extrapolation. Quotes require positive finite IV, finite strike and delta, and finite bid/ask with `bid >= 0`, `ask > 0`, and `ask >= bid`.

ATM is the closest strike to the underlying with valid call and put quotes; equal distances choose the lower strike. ATM IV is the mean of that pair's IVs. Missing one wing leaves skew unavailable but permits the other wing's ATM spread. Missing ATM leaves both wing spreads unavailable but still permits skew. Missing values are gaps, never zeroes or connected lines.

Compact history retains all quotes for the selected expiration, allowing delta changes on retained history. Quotes already removed from older snapshots cannot be recovered. History length and polling interval remain the tab's existing settings. Existing widgets and provider behavior are unchanged.
