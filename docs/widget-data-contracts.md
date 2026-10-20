# Widget Data Contracts

Widgets can act as derived data sources inside the dashboard.

For interaction events, use the parallel event contract architecture described in [Widget Event Contracts](widget-event-contracts.md). For plugin-owned widget controls and data-publish subscribers, use [Widget Plugin Extensions](widget-plugin-extensions.md).

The primary market-data provider still owns raw snapshots. A widget may then transform that snapshot into a structured output and publish it through the renderer's local widget data store. Other widgets should consume that published output instead of re-running the producer widget's calculation.

## Why

This keeps responsibilities clean:

- producer widgets own their calculation contract
- consumer widgets read stable widget outputs
- derived widgets do not duplicate upstream math
- future APIs, including an MCP server for the volatility dashboard, can expose each widget as a dataset

## Current Pattern

`Straddle ATM` publishes one output per widget instance:

```ts
{
  type: "atm-straddle",
  status: "ok" | "error",
  title: string,
  config: object,
  snapshot?: StraddleSnapshot,
  error?: string,
  tabId: string,
  widgetId: string,
  updatedAt: string
}
```

`Vol Upfront` consumes published `Straddle ATM` outputs from the current tab and calculates forward volatility from their `snapshot.dte` and `snapshot.atmIv` fields. It does not recalculate straddles.

`SPX IV / RV` publishes its aligned implied-vs-realized volatility dataset after the widget renders:

```ts
{
  type: "iv-rv-local",
  status: "ok" | "waiting_for_local_sources" | "error",
  title: string,
  config: object,
  horizon?: {
    days: number,
    label: string,
    ivSymbol: string | null
  },
  sources?: {
    spx: WidgetMarketDataSource,
    iv: WidgetMarketDataSource
  },
  latest?: IvRvPoint,
  latestSpxDate?: string | null,
  series?: IvRvPoint[],
  warnings?: string[],
  error?: string,
  tabId: string,
  widgetId: string,
  updatedAt: string
}
```

Each `WidgetMarketDataSource` includes `symbol`, `provider`, `cached`, `fallback`, `updatedAt`, and `warning`. MCP exposes this dataset through `get_widget_data` once the containing dashboard tab has rendered in the open UI runtime.

`n-Delta IV` reads the tab's historical option-chain snapshots and produces three aligned chart series for one expiration:

```ts
{
  type: "n-delta-iv",
  config: {
    symbol: string,
    baseStrike: number | "ATM",
    optionType: "put" | "call",
    targetDelta: number,
    expiration: string
  },
  points: NDeltaIVPoint[],
  deltaIVSeries: Array<number | null>,
  atmIVSeries: Array<number | null>,
  deltaIVPremiumSeries: Array<number | null>
}
```

Each point follows this shape:

```ts
type NDeltaIVPoint = {
  timestamp: string | number
  expiration: string
  optionType: "put" | "call"
  targetDelta: number
  anchorStrike: number | null
  matchedStrike: number | null
  matchedDelta: number | null
  deltaIV: number | null
  atmStrike: number | null
  atmIV: number | null
  deltaIVPremium: number | null
}
```

The first implementation calculates this output in the renderer from history and does not persist or republish it through the widget data store yet.

`IV Dynamics` publishes the rendered heatmap matrix after each render:

```ts
{
  type: "iv-dynamics",
  status: "ok" | "error",
  title: string,
  config: {
    expiration: string,
    deltas: string,
    mode: "premium" | "iv",
    compareMode: "previous" | "session",
    maxColumns: number,
    showBA: boolean
  },
  expiration?: string,
  mode?: "premium" | "iv",
  compareMode?: "previous" | "session",
  rows?: Array<{ key: string, side: "put" | "call", delta: number | "ATM", label: string }>,
  columns?: Array<{ timestamp: string | number, expiration: string, label: string, baPrice: number | null }>,
  baSeries?: Array<{ timestamp: string | number, label: string, price: number | null, y: number | null }>,
  cells?: Array<Array<{
    baPrice: number | null,
    iv: number | null,
    atmIV: number | null,
    premium: number | null,
    value: number | null,
    matchedStrike: number | null,
    matchedDelta: number | null,
    comparisons: {
      previous: number | null,
      m15: number | null,
      m60: number | null,
      session: number | null
    }
  }>>,
  warnings?: string[],
  error?: string
}
```

`mode: "premium"` means cells display `IV minus ATM`; `mode: "iv"` means cells display absolute IV. Colors are calculated from the selected value's change versus the previous available column in the same row.
When `showBA` is enabled, the renderer draws a compact spot-price overlay from root `snapshot.px`; `baSeries.y` is normalized for plotting and uses `0.5` for flat finite price ranges.

`Option Flow TICK` is a `timeseries-custom` chart widget backed by the `tape-contract` datasource. It publishes through the chart runtime path rather than the table widget data store:

```ts
{
  kind: "chart",
  type: "option-flow-tick",
  mode: "timeseries-custom",
  config: {
    strikeWindow: number | string,
    flowDisplayMode: "cumulative" | "linear" | "ma-1m" | "ma-3m" | "ma-5m" | "ma-15m",
    displayPointOffset: number | "",
    displayPointLimit: number | ""
  },
  historyLength: number,
  sourceSnapshotTime: string | null,
  chart: {
    labels: string[],
    datasets: Array<{
      label: "Bought calls" | "Sold calls" | "Bought puts" | "Sold puts",
      data: number[],
      pointMeta: Array<{
        timestamp: string | number,
        px: number | null,
        strikeWindow: number | string,
        displayMode: "cumulative" | "linear" | "ma-1m" | "ma-3m" | "ma-5m" | "ma-15m",
        flowWindowMinutes: number | null,
        allowedStrikes: number[],
        records: number,
        matchedRecords: number,
        increments: {
          boughtCalls: number,
          soldCalls: number,
          boughtPuts: number,
          soldPuts: number
        },
        totals: {
          boughtCalls: number,
          soldCalls: number,
          boughtPuts: number,
          soldPuts: number
        },
        displayTotals: {
          boughtCalls: number,
          soldCalls: number,
          boughtPuts: number,
          soldPuts: number
        }
      }>
    }>
  }
}
```

For both option flow widgets, `strikeWindow` is a nonnegative number for a symmetric window, a signed string such as `"+3"` or `"-5"` for a directional window, or `"ALL"` for all observed strikes. Metadata and calculation summaries preserve this normalized value. Existing positive numeric settings retain their behavior; negative numeric configuration values normalize to downward signed strings. Invalid external configuration falls back to `3`.

The series are cumulative `size_contracts` totals by default. In Linear mode, each point displays only its own snapshot increments; Balanced TICK derives balances and imbalance from those increments, with zero imbalance when gross volume is zero. Cumulative metadata is retained in every mode; `flowWindowMinutes` is `null` for Linear and Cum. In MA display modes they are trailing timestamp-window sums of per-snapshot increments for tape rows whose `call_put` is `CALL` or `PUT`, whose `aggressor_buy_sell` is `BUY` or `SELL`, and whose strike is selected by the widget's `ATM` strike window (`ALL` does not require an underlying price). `displayPointOffset` and `displayPointLimit` trim rendered points after calculation and do not alter metric values. Details: [Tape Contract Datasource](tape-contract-datasource.md).

`Option Flow Balanced TICK` uses the same source rows and strike filtering, but publishes four balance datasets:

```ts
{
  kind: "chart",
  type: "option-flow-balanced-tick",
  mode: "timeseries-custom",
  config: {
    strikeWindow: number | string,
    flowDisplayMode: "cumulative" | "linear" | "ma-1m" | "ma-3m" | "ma-5m" | "ma-15m",
    displayPointOffset: number | "",
    displayPointLimit: number | ""
  },
  historyLength: number,
  sourceSnapshotTime: string | null,
  chart: {
    labels: string[],
    datasets: Array<{
      label: "Calls balance" | "Puts balance" | "Directional balance" | "Imbalance",
      data: number[],
      pointMeta: Array<{
        timestamp: string | number,
        px: number | null,
        strikeWindow: number | string,
        displayMode: "cumulative" | "linear" | "ma-1m" | "ma-3m" | "ma-5m" | "ma-15m",
        flowWindowMinutes: number | null,
        allowedStrikes: number[],
        records: number,
        matchedRecords: number,
        increments: {
          boughtCalls: number,
          soldCalls: number,
          boughtPuts: number,
          soldPuts: number
        },
        totals: {
          boughtCalls: number,
          soldCalls: number,
          boughtPuts: number,
          soldPuts: number
        },
        balances: {
          callsBalance: number,
          putsBalance: number,
          directionalBalance: number,
          imbalance: number
        },
        displayTotals: {
          boughtCalls: number,
          soldCalls: number,
          boughtPuts: number,
          soldPuts: number
        },
        displayBalances: {
          callsBalance: number,
          putsBalance: number,
          directionalBalance: number,
          imbalance: number
        }
      }>
    }>
  }
}
```

Option-side balances are calculated as bought contracts minus sold contracts for the active display mode. Directional balance is calls balance minus puts balance. Imbalance is directional balance divided by the active display mode's total bought/sold call/put contracts, or `0` when that total is zero.

## Implementation Notes

- The widget data store is local to the renderer runtime.
- `publishWidgetData` notifies plugin data subscribers after updating the widget data store and MCP runtime store.
- Widget data subscriber failures are caught and logged; they must not break widget rendering.
- Full dashboard refresh renders producer table widgets before widget-data consumers.
- When a `Straddle ATM` config changes, dependent `Vol Upfront` widgets are refreshed after the source output is republished.
- Exact persistence of widget outputs is intentionally not implemented yet; outputs are recalculated from current snapshots and widget configs.
