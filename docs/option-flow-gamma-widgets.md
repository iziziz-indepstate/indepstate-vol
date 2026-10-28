# Flow Gamma Widgets

`Flow. Gamma Flow` (`option-flow-gamma-flow`) and `Flow. Gamma Imbalance`
(`option-flow-gamma-imbalance`) consume `tape-contract` history. They describe observed
SPX/SPXW 0DTE transaction flow, not dealer GEX, open positions, or a directional SPX forecast.
SPX tape is assumed to represent PM-settled SPXW options; do not send AM-settled series under
this contract. There is no cross-tab join to TradingView or another chain.

## Controls and time

**Exclude flagged trades** is an optional per-widget checkbox (default: off). It removes
trades whose `String(condition_flag ?? '').trim()` is non-empty from all Gamma metrics,
including revalued and imbalance modes. Exclusions are reported as `condition_flag` in
diagnostics. Observed strike ladders, anchors and underlying prices still use all records.
See [the shared filter rules and history compatibility](tape-contract-datasource.md#flagged-trade-filter).

Gamma calibration scope keys preserve the legacy format when the filter is off. When on,
`gammaScopeKey` appends `"excludeFlaggedTrades"` to its JSON array. Calibrations must match
this filtered scope; unfiltered calibrations cannot confirm filtered flow.

Defaults: Executed Gamma, Total, Dynamic ATM ±3 observed strikes, Session from 09:30
America/New_York, and all signed trade gamma. The chart time axis uses New York time.
Runtime timestamps and time-anchor inputs use absolute ISO timestamps with `Z` or a UTC offset.

Strike lists and time/ATM anchors are optional in the default Dynamic ATM + Session settings.
Only Explicit Strikes needs the strike-list field; only Anchored ATM uses the saved ATM anchor;
only Anchored cumulative needs a time anchor. Irrelevant inputs are hidden and do not gate
flow calculation. Before 09:30 New York time, Session reports that the regular session has not
opened; this is not a missing-anchor error. Missing/invalid execution timestamps are reported
separately and cannot be repaired by filling widget anchor inputs.

- **Gamma:** Executed sums the original signed trade gamma. Revalued Proxy applies current
  per-contract quote gamma to the original signed contract quantities, in the same source units.
  The sender updates gamma as spot, IV and time change. IS-VOL does not derive gamma from IV.
- **Options:** Total / Calls / Puts. Purchased calls and purchased puts both contribute positive gamma.
- **Scope:** Dynamic ATM, Anchored ATM, Explicit Strikes. Width is a nonnegative integer,
  e.g. 1/2/3/5. Explicit accepts `7740,7750,7760` or inclusive `7700:7800`.
- **Dynamic ATM:** nearest observed strike at execution time, lower strike on ties.
  The ladder comes from available tape/contract/quote records of that expiry, not an assumed
  grid. Unobserved neighbors cannot be selected. Trade eligibility and its downside/ATM/upside
  segment stay fixed when current ATM moves.
- **Anchored ATM:** selecting this scope captures ATM and the available ladder from retained
  history. Enter another ISO ATM-anchor timestamp to capture a different historical anchor.
  Captured timestamp, ATM and ladder persist in configuration. Changing width deliberately
  changes the selection around the saved ATM; spot movement does not. Missing anchor data gives N/A.
- **Window:** Session; Rolling with 1/5/15/30 or custom positive integer minutes;
  Anchored cumulative with an ISO time anchor. Rolling includes `t-W < execution <= t`;
  cumulative includes `anchor <= execution <= t`. Minutes do not affect cumulative modes.
- **Classification:** all signed gamma or only records marked `reliable`.
  A missing or conflicting BUY/SELL label does not invalidate or re-sign supplied gamma.
- **Quote age:** maximum age in seconds, default 60. An unreliable latest quote invalidates
  that contract; the calculator does not silently fall back to an older reliable quote.

Historical points rebuild on settings changes or history retention trimming. Ordinary appends
are processed incrementally. No-trade polling adds lightweight gamma-clock history points when
a gamma widget is present. These advance rolling expiry and quote freshness, are not saved as
raw snapshots, and are ignored by the existing TICK widgets.

## Metrics and missing data

Calibration is optional for Gamma Flow, raw B and Revalued Gamma. It is required only
for historically normalized IV/skew pressure and the dependent confirmed C/R/A metrics.
The activity threshold is independently optional: `uncalibrated` means that no historical
low-activity threshold is available, not that the gamma amounts or raw imbalance are invalid.
Gamma Flow details do not report missing IV calibration as a flow failure.

Tape `gamma` is already the full signed gamma of the trade, including its contract size.
`Net = Σ gamma`, `Bought = Σ max(gamma,0)`, `Sold = Σ max(-gamma,0)` and
`Gross = Σ abs(gamma)`. There is no second multiplication by size, 100, spot squared or 0.01,
and no second sign assignment from BUY/SELL. For example +7200 and -1500 give Net 5700
and Gross 8700. Calls and puts use the same sign convention. Each linked leg contributes
its own signed gamma. Values remain in source gamma units, not an inferred USD/1% unit.
`contract.gamma_notional` is never substituted for the tape field.

Revalued uses `Σ sign(trade.gamma) × trade.size_contracts × current_quote.gamma`.
Quote gamma must be a nonnegative per-contract value in the same source units; the sender
updates it for current spot, IV and time. Size is needed only for Revalued, not for summing
Executed gamma. Spot remains the tape reference for ATM selection and visible market context;
it is not multiplied into an already supplied gamma again.

Gamma Flow plots Net Gamma and an always-visible zero reference. Details show
Net/Gross/Bought/Sold, history coverage, activity and exclusions. Revalued details separate
new signed gamma, signed removal from the window, and revaluation of continuing trades.
Where both endpoints are available, their sum reconciles the change in Net Gamma.

Gamma Imbalance has two analyses:

- **IV Confirmation:** `B=(Bought-Sold)/Gross`, gross-weighted segment Z, and
  `C=B×(1+tanh(sign(B)×Z))/2`. Z has its own right axis; B/C use [-1,1].
- **Relative Convexity Demand:** downside/ATM/upside R and `A=(R_upside-R_downside)/2`.
  Details include each segment's B, Gross, representative IV, skew versus ATM, skew change,
  relative Z and availability. ATM uses adjusted absolute IV pressure; wings use relative
  skew changes divided by historical skew scales.

The large details panel is hidden by default. Enable the **debug** checkbox to display it;
the choice persists per widget. With debug enabled, hover to inspect a historical point in
the details area; leaving restores the latest point.
Every dataset's `pointMeta` publishes the same metrics through the normal MCP chart runtime,
including settings, scope key, observation/receipt times, exclusion counts and history coverage.

Empty selections and zero Gross have no imbalance. Missing/stale quotes, nonmatching evidence
or absent scales produce null chart gaps and N/A. If any selected contract lacks a current
quote, the whole selected Revalued total is unavailable. Executed totals include valid executions
with omitted records counted by reason. Missing execution gamma is never inferred.

Low activity is identified using the supplied historical segment/context threshold. Without
it, activity is `uncalibrated`. History beginning after the requested window start is marked
incomplete; selecting Session does not imply the application collected the entire session.

## Input API

Use `POST http://127.0.0.1:8124/tape-contract/batch` with the existing envelope:

```json
{
  "schema": "tape.contract.csv.v1",
  "kind": "quote",
  "sentAt": "2026-10-16T13:31:00.500Z",
  "records": []
}
```

`tape` and `contract` remain compatible; `quote` and `calibration` are new kinds.
Analytical batches validate fully before ingestion. Invalid records reject the batch.
Analytical records require explicit units, absolute timestamps and `expiration_at` later
than the timestamp. Quotes dedupe by contract plus timestamp, permitting updates.
Newer quote timestamps take precedence over late older arrivals. Calibration dedupes by
normalized content. Raw/compact persistence retains all analytical fields and provenance.

### Tape additions

```json
{
  "underlying": "SPX",
  "expiration": "2026-10-16",
  "strike": 7750,
  "call_put": "CALL",
  "size_contracts": 10,
  "aggressor_buy_sell": "BUY",
  "gamma": 0.012,
  "gamma_unit": "per_point",
  "underlying_price": 7751.5,
  "executed_at": "2026-10-16T13:31:00.000Z",
  "classification_quality": "reliable",
  "complex_order_id": "",
  "trade_id_sequence": "execution-123",
  "iv": "20%"
}
```

Tape gamma is the signed, size-inclusive trade value, including negative values. Its sign
is authoritative even when BUY/SELL is absent or disagrees. The legacy `gamma_unit` field
is preserved but does not trigger a notional conversion. Classification quality defaults to `unknown`; only `reliable`
passes the reliable-only filter. The tape's `timestamp` is authoritative; `executed_at` is a
compatibility alias when timestamp is absent. Absolute ISO timestamps and local date/time
strings are accepted. A time-only timestamp uses the 0DTE expiration date and the supplied
timezone (New York by default). Trade times are not compared with send/receipt timestamps
and are not rejected for being earlier or later than the dump. The observation clock starts
from tape time, so replayed dumps work independently of the recorder's wall clock. Polling
advances that source clock by elapsed time when no newer execution is available. Send/receipt
times remain separate metadata; only missing or unreadable trade times cannot be used.
New fields, IV, complex-order identity and
send/receipt timestamps survive history compaction.

### Quote records

```json
{
  "underlying": "SPX",
  "expiration": "2026-10-16",
  "strike": 7750,
  "call_put": "CALL",
  "timestamp": "2026-10-16T13:31:00.000Z",
  "expiration_at": "2026-10-16T20:00:00.000Z",
  "gamma": 0.012,
  "gamma_unit": "per_point",
  "iv": 0.20,
  "iv_unit": "decimal",
  "forward": 7752.0,
  "quality": "reliable"
}
```

Quote gamma is nonnegative and per contract, in the same source units as aggregate trade gamma.
All shown fields are required. `underlying_price` in a quote is optional for compatibility;
it does not supply the current spot. The shared spot is the latest positive `underlying_price`
from any SPX/SPXW tape execution at or before the observation time, including executions outside
the widget's expiry, strike, option-type, aggressor and gamma filters. Late older executions,
invalid prices and other underlyings cannot overwrite it. Historical analytical windows use
executions at/before their own endpoint, independently of recorder time. The last known
price is retained until another valid execution arrives. Runtime metadata exposes
`currentSpotSource` and `currentSpotTimestamp`; Revalued details show the spot and its execution time.
Anchored ATM capture uses the same tape source. Executed Gamma preserves the original signed gamma.

Quality is `reliable`, `unreliable` or `unknown`; only reliable
quotes are analytically usable. Supply the actual expiry time, including early closes.
For new analytical kinds IV is numeric decimal (0.20 = 20%), never a percent string.

### Calibration and comparable IV records

Each record supplies a segment's historical normalization and externally prepared comparable
surface measurements for exactly the selected window. The producer uses the same selection
and Gamma Mode when constructing segment representative IV/adjusted changes. Surface fitting,
mechanical moneyness/time adjustment and historical estimation belong to the producer.
IS-VOL validates context and applies the formulas; it does not train a substitute model.

```json
{
  "underlying": "SPX",
  "expiration": "2026-10-16",
  "expiration_at": "2026-10-16T20:00:00.000Z",
  "timestamp": "2026-10-16T13:31:00.000Z",
  "quality": "reliable",
  "scope_key": "[\"dynamic\",3,\"\",\"\",\"\",\"\",\"all\"]",
  "gamma_mode": "executed",
  "option_types": "total",
  "segment": "atm",
  "window_start": "2026-10-16T13:30:00.000Z",
  "window_end": "2026-10-16T13:31:00.000Z",
  "iv_unit": "decimal",
  "comparison_method": "constant_forward_moneyness_adjusted",
  "historical": true,
  "sample_count": 250,
  "tod_start_minute": 570,
  "tod_end_minute": 600,
  "min_seconds_to_expiry": 0,
  "max_seconds_to_expiry": 24000,
  "iv_scale": 0.005,
  "skew_scale": 0.003,
  "activity_threshold": 1000000,
  "adjusted_iv_change": 0.002,
  "comparable_iv_start": 0.20,
  "comparable_iv_end": 0.202
}
```

Segments: `downside`, `atm`, `upside`. Option types: `total`, `call`, `put`.
`scope_key` is `gammaScopeKey(config)` from `src/shared/gamma-flow-calculations.mjs`, also
available in runtime metadata. It serializes
`[scope,width,explicitStrikes,anchorAt,anchorATM,anchorLadder,qualityFilter]`.
Use the exact runtime value, especially for anchored scopes. Gamma mode and option type also match.

Window endpoints must equal the actual analytical window. `timestamp` is evidence production time,
at or after the window end. Time-of-day bounds are New York minutes [start,end); remaining-time
bounds are seconds to expiry. Historical sample count must be positive, scales positive and
thresholds nonnegative. A reliable label asserts the producer's historical sample is adequate
for that context. Optional absent measurements/scales leave dependent metrics unavailable.
IV endpoints must use comparable forward moneyness, the same expiry and consistent construction.

For IV Confirmation, segment Z is `adjusted_iv_change / iv_scale`; total Z uses segment Gross
Gamma weights. Every contributing contract must also have a usable quote. Relative analysis forms
wing-minus-ATM IV at both endpoints, then divides its change by the wing's `skew_scale`.
ATM uses its adjusted absolute Z.

Transport latency is handled by evaluating fresh calibration at its declared window end when
that end is later than the previous plotted observation. Only quotes at/before that time are used;
receipt time is preserved separately. No-evidence polling advances the clock: old evidence cannot
confirm a different rolling window. Evidence older than an already plotted observation cannot
silently rewrite it. Publish fresh evidence regularly alongside quotes. Without this integration,
Executed flow and raw B can operate, while dependent Z/C/R/A remain unavailable.

## Validation

`test/gamma-flow-calculations.test.mjs` covers signs, confirmation, ATM migration, rolling
boundaries, spreads, missing data, DST, raw/compact and replay/incremental equivalence,
retention and transport latency. Receiver tests cover units, atomic validation and versioned
quotes/calibration. Run `node --check src/renderer/app.js` and `npm test`.


## Underlying price overlay and time axis

Both Gamma widgets offer a `BA` checkbox (saved `showUnderlying` boolean, default
`false`). It plots each observation's `currentSpot` as a muted background line
on its own right price axis; Gamma Imbalance keeps its IV Pressure Z axis too.
No additional forward filling is applied. The X axis now uses local computer
time in `HH:mm:ss`, with labels thinned to fit the chart width.
See [shared Flow chart behavior](tape-contract-datasource.md#underlying-price-overlay-and-time-axis).
