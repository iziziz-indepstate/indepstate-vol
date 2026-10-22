# Tape Contract Datasource

The `tape-contract` datasource receives option-flow batches in the `tape.contract.csv.v1` format and exposes drained snapshots to dashboard widgets.

It is implemented as a main-process plugin under `src/plugins/tape-contract-datasource/`.

## Endpoint

When the app is running, the receiver listens on:

```text
POST http://127.0.0.1:8124/tape-contract/batch
```

Only `POST` is accepted. Opening the URL in a browser sends `GET` and returns `{"ok":false,"error":"Not found"}`.

Request body:

```json
{
  "schema": "tape.contract.csv.v1",
  "kind": "tape",
  "sentAt": "2026-10-12T18:24:29.329Z",
  "records": [
    {
      "timestamp": "21:24:14.000",
      "timezone": "America/New_York",
      "underlying": "SPX",
      "expiration": "2026-10-12",
      "strike": 7740,
      "call_put": "PUT",
      "trade_price": "$0.15",
      "size_contracts": 1,
      "underlying_price": "$7,799.8",
      "aggressor_buy_sell": "BUY",
      "trade_id_sequence": "9aaa808f-89fa-4738-9834-93ed96cf6eb6"
    }
  ]
}
```

Accepted envelope fields:

- `schema`: must be `tape.contract.csv.v1`.
- `kind`: `tape`, `contract`, `quote` or `calibration`.
- `sentAt`: valid ISO timestamp.
- `records`: array.

## Ingestion

Incoming records are normalized and deduped before the renderer can fetch them.

Tape dedupe key:

- preferred: `trade_id_sequence`
- fallback: `timestamp + underlying + expiration + strike + call_put + size_contracts + premium + aggressor_buy_sell`

Contract dedupe key:

- `underlying + expiration + strike + call_put`

Accepted records stay in memory as pending records. On each datasource poll, the renderer asks the plugin for a snapshot and the plugin drains all currently pending records into that snapshot.

If there are no new deduped records, the plugin returns a no-op snapshot. No-op snapshots are not added to tab history and do not create raw snapshot files.

## Storage

The datasource follows the same raw/compact rules as other providers:

- raw snapshot saving stores full non-empty drained batches
- compact history keeps only fields needed by widgets
- `keepPoints`, `pollSec`, and history persistence continue to apply

Compacted tape records keep:

- timestamp, timezone, underlying, expiration, strike
- call/put side and aggressor buy/sell side
- `size_contracts`, `premium`, `underlying_price`, `delta`
- `trade_id_sequence` and `_dedupeKey`

## ATM Price

The datasource uses tape `underlying_price` as the primary ATM reference.

Formatted market values are accepted, for example `$7,799.8` and `23.73%`. The plugin attaches the latest valid `underlying_price` from each drained tape snapshot as `snapshot.px`.

No Yahoo lookup is used for this datasource.

## Option Flow TICK Widget

The gamma widgets also use this datasource, with additional execution fields and analytical
quote/calibration records. See [Option Flow Gamma Widgets](option-flow-gamma-widgets.md).

`Option Flow TICK` is the paired chart widget for `tape-contract` history.

It renders four cumulative lines:

- `Bought calls`
- `Sold calls`
- `Bought puts`
- `Sold puts`

The metric is `size_contracts`. Rows with invalid or missing `strike`, `size_contracts`, `call_put`, or `aggressor_buy_sell` are ignored.

The widget control `ATM` accepts `3 / +3 / -5 / ALL`. Default is `3`:

- `3`: ATM plus up to three observed strikes on each side.
- `+3`: ATM plus up to three observed strikes above it.
- `-5`: ATM plus up to five observed strikes below it.
- `0`, `+0`, `-0`: ATM only.
- `ALL`: every observed strike, even without an underlying price.

Counts must be whole numbers. Leading/trailing whitespace is ignored; `ALL` is case-insensitive. Invalid or empty input keeps the previous setting. The `ATM` suffix is not accepted. The setting applies equally to calls and puts and recalculates retained history.

The widget control `Flow` selects display mode:

- `Cum`: cumulative totals since the start of retained history
- `Linear`: each point shows only its own snapshot increments, preserving chart history
- `MA 1m`, `MA 3m`, `MA 5m`, `MA 15m`: trailing timestamp-window sums of per-snapshot tape increments

The display-only point-window controls trim rendered chart points after calculation:

- `From`: skip the first N calculated points. Empty is the default and means `0`.
- `Last`: show only the last N calculated points after `From` is applied. Empty is the default and means no limit.

These controls do not change cumulative totals, MA windows, or tooltip metadata values for retained points.

For each drained tape snapshot, the widget:

1. Reads ATM from `snapshot.px`, falling back to record-level `underlying_price`.
2. Builds the sorted set of observed tape strikes in that snapshot.
3. Selects the observed strike nearest to ATM (the lower strike wins a tie), unless `ALL` is selected.
4. Includes ATM and the configured count of observed strikes on both sides or only the signed side, or all strikes for `ALL`. Counts follow the sorted observed strikes, regardless of price gaps; insufficient strikes are used as available.
5. Adds matching record `size_contracts` into the matching call/put and buy/sell cumulative bucket.

Tooltips and runtime chart data include per-point metadata:

- timestamp
- ATM price
- strike window
- display mode and MA window, when selected
- allowed strikes
- matched record count
- per-series increments
- cumulative totals and displayed totals

## Option Flow Balanced TICK Widget

`Option Flow Balanced TICK` uses the same `tape-contract` history, ATM selection, observed strike-window filtering, and `size_contracts` metric as `Option Flow TICK`.

It renders four balance lines:

- `Calls balance`: bought calls minus sold calls
- `Puts balance`: bought puts minus sold puts
- `Directional balance`: calls balance minus puts balance
- `Imbalance`: directional balance divided by total bought/sold call/put contracts

The widget controls `ATM`, `Flow`, `From`, and `Last` match `Option Flow TICK`. In Linear mode, balances and imbalance are derived from the individual snapshot increments; imbalance is zero when total snapshot volume is zero. In MA modes, balances and imbalance are derived from trailing timestamp-window sums instead of cumulative totals.

Tooltips and runtime chart data include the same per-point metadata as `Option Flow TICK`, plus cumulative and displayed `balances` for the rendered lines.

## Runtime Data

Both option-flow widgets use the normal `timeseries-custom` / uPlot path. MCP/open-runtime inspection exposes them as chart runtime data with `pointMeta` arrays.

The datasource itself is exposed through the generic preload bridge:

```js
window.appBridge.getDataSourceSnapshot('tape-contract', config)
```

The main-process IPC handler is registered by the datasource plugin as:

```text
tape-contract:get-snapshot
```

## Tests

Relevant tests:

- `test/tape-contract-receiver.test.cjs`
- `test/option-flow-tick-calculations.test.mjs`
- `test/snapshot-trim.test.mjs`

Useful checks:

```bash
node --check src\plugins\tape-contract-datasource\main.cjs
node --check src\plugins\tape-contract-datasource\receiver.cjs
node --check src\renderer\app.js
npm test
```


## Underlying price overlay and time axis

All four Option Flow widgets (TICK, Balanced TICK, Gamma Flow and Gamma Imbalance)
provide a `BA` checkbox backed by `config.showUnderlying` (boolean, default `false`).
The setting is saved separately for each widget. When enabled, runtime datasets
append an `Underlying` series (`seriesKey: "underlying"`, `yAxisID: "underlying"`)
without changing the indices of existing flow series. Its `pointMeta` matches the
flow observations. The renderer draws this muted gray line behind the flow on an
independent right price axis with two decimal places and no additional grid.
The checkbox controls its visibility; it has no separate legend toggle.
Gamma Imbalance retains its separate IV Pressure Z axis alongside the price axis.

TICK and Balanced TICK use each point's calculated `px`; Gamma widgets use
`currentSpot`. Flow filters, cumulative mode and moving-window sums do not
transform the underlying price. Missing prices remain `null`, with gaps in the
line and no zero substitution or additional forward filling. TICK's `From` and
`Last` controls trim all series together.

The X axis displays local computer time as `HH:mm:ss` from the original point
`timestamp`, including on Gamma widgets. Labels are thinned automatically to fit
the chart width and only mark whole observation indices. Observations remain
equally spaced, even when elapsed time between them differs.
