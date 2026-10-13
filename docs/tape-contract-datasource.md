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
- `kind`: `tape` or `contract`.
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

`Option Flow TICK` is the paired chart widget for `tape-contract` history.

It renders four cumulative lines:

- `Bought calls`
- `Sold calls`
- `Bought puts`
- `Sold puts`

The metric is `size_contracts`. Rows with invalid or missing `strike`, `size_contracts`, `call_put`, or `aggressor_buy_sell` are ignored.

The widget control `±S` is the strike-window size around ATM. Default is `3`.

For each drained tape snapshot, the widget:

1. Reads ATM from `snapshot.px`, falling back to record-level `underlying_price`.
2. Builds the sorted set of observed tape strikes in that snapshot.
3. Selects the observed strike nearest to ATM.
4. Includes `±S` observed strikes around that nearest strike.
5. Adds matching record `size_contracts` into the matching call/put and buy/sell cumulative bucket.

Tooltips and runtime chart data include per-point metadata:

- timestamp
- ATM price
- strike window
- allowed strikes
- matched record count
- per-series increments
- cumulative totals

## Runtime Data

The widget uses the normal `timeseries-custom` / uPlot path. MCP/open-runtime inspection exposes it as chart runtime data with four datasets and `pointMeta` arrays.

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
