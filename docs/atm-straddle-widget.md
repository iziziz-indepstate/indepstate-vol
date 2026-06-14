# Straddle ATM Widget

The `Straddle ATM` widget is a compact widget for reading the current price of movement in a selected symbol expiry before analyzing skew, OTM bid premium, or wing velocity.

## Product Goal

The widget answers:

- How much movement is the selected expiry pricing right now?
- Is the ATM straddle getting cheaper or more expensive?
- Is ATM volatility being crushed or still bid?
- Is the quote quality good enough to trust the value?

## Controls

- `Tenor`: target expiry bucket. Calendar-day mapping is `0DTE=0`, `1D=1`, `1W=7`, `2W=14`, `1M=30`, `2M=60`, `3M=90`, `6M=180`.
- `Expiry`: optional exact override selected from the date picker in `YYYY-MM-DD` format. When set, tenor-based selection is skipped.
- `ATM K`: optional ATM strike override. It accepts an exact strike or explicit `ATM`. When empty or set to `ATM`, the calculator selects the valid call/put pair nearest to the reference price. When set to a number, the selected expiry must contain a valid call/put pair at that strike.
- `Spot S`: optional manual reference price. It accepts a number or explicit `Auto`. When empty or set to `Auto`, the widget uses spot from the datasource (`snapshot.px`). When set to a number, this value drives ATM selection, implied move percent, and expected range.
- `Pick`: expiry selection mode: `nearest`, `at_or_after`, or `at_or_before`.
- `Compare`: `previous_close`, `previous_snapshot`, or `none`. The app uses stored option-chain snapshots from the current tab. If comparison data is unavailable, the widget still renders the current value and shows comparison unavailable.
- `Compact`: dashboard-card layout with headline values only.

## Price History

The widget renders a small straddle-price sparkline above the text output. It recalculates the same selected tenor, expiry override, ATM strike override, and reference-price mode across the current tab history.

- At least two matching snapshots are required.
- Historical snapshots that no longer contain the selected expiry or strike are skipped.
- The sparkline uses the last 120 matching history candidates and colors the line green when the latest value is above the first plotted value, red when below, and blue when flat.

## Calculation Contract

- Pure calculation lives in `src/shared/atm-straddle-calculations.mjs`.
- UI lives in `src/renderer/widgets/atm-straddle-widget.js` and consumes only the calculated snapshot.
- The widget uses the existing TradingView option-chain snapshot (`byExpiry`, `optionQuotes`, `px`) and does not add another market-data provider.
- Reference price defaults to spot (`px`). The `Spot S` control switches the widget to manual reference price mode when filled.

## Expiry Selection

When `Expiry` is empty, the calculator parses `Tenor` into a target DTE and evaluates valid expiries from the option-chain snapshot. A valid tenor candidate must contain at least one valid call/put pair, so generated empty dates such as weekends are skipped.

- `nearest`: choose the expiry with the smallest absolute distance to target DTE. Ties choose the later expiry.
- `at_or_after`: choose the first expiry with DTE greater than or equal to target DTE.
- `at_or_before`: choose the latest expiry with DTE less than or equal to target DTE.

When `Expiry` is set, the exact expiry is used and tenor-based selection is skipped. Exact overrides stay strict: the widget does not silently jump to another expiry if the selected date has no valid ATM pair.

## ATM Strike Selection

For the selected expiry, the calculator builds call/put pairs by strike and excludes invalid quotes. If `ATM K` is numeric, that exact strike is used. If `ATM K` is empty or `ATM`, it selects the strike nearest to the reference price. If strikes are tied by distance, the pair with better quote quality wins. If the reference price is missing, the calculation layer can fall back to the most delta-neutral pair using `callDelta + putDelta`.

## Quote Quality

Quote quality flags:

- `OK`
- `WIDE_SPREAD`
- `MISSING_BID_ASK`
- `STALE_QUOTE`
- `NEGATIVE_OR_INVALID_QUOTE`
- `LOW_CONFIDENCE`

The straddle spread percent is calculated as:

```text
(straddleAsk - straddleBid) / straddleMid
```

`WIDE_SPREAD` is added above 5%. `LOW_CONFIDENCE` is added above 10%, for stale quotes, or when comparison data is missing.

## Core Outputs

The snapshot includes:

- selected expiry and DTE
- reference price and source
- ATM strike and selection method
- call and put bid/ask/mid/IV/Greeks
- straddle bid/mid/ask
- implied move in points and percent
- expected range: `S +/- straddleMid`
- ATM IV and call/put IV spread
- net Greeks
- comparison deltas when available
- state labels and quality flags

## State Labels

- `VOL_CRUSH`: straddle is down more than 5% and ATM IV is lower versus comparison.
- `MOVEMENT_BID`: straddle or ATM IV is flat/up versus comparison.
- `SPOT_UP_VOL_UP`: spot is higher while ATM IV is higher.
- `SPOT_DOWN_VOL_DOWN`: spot is lower while ATM IV is lower.
- `LOW_CONFIDENCE`: warning badge when quotes are wide/stale or comparison is missing.

## Error Handling

The widget renders useful text instead of crashing:

- no matching expiry
- no valid ATM call/put pair
- no valid pair for a manual `ATM K`
- missing reference price
- stale or low-confidence data

## Tests

The unit tests in `test/atm-straddle-calculations.test.mjs` cover:

- tenor parsing
- expiry selection
- ATM strike selection and tie-breaking
- quote validation
- straddle math
- historical comparison
- state labels
