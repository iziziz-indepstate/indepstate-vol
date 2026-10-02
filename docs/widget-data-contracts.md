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

## Implementation Notes

- The widget data store is local to the renderer runtime.
- `publishWidgetData` notifies plugin data subscribers after updating the widget data store and MCP runtime store.
- Widget data subscriber failures are caught and logged; they must not break widget rendering.
- Full dashboard refresh renders producer table widgets before widget-data consumers.
- When a `Straddle ATM` config changes, dependent `Vol Upfront` widgets are refreshed after the source output is republished.
- Exact persistence of widget outputs is intentionally not implemented yet; outputs are recalculated from current snapshots and widget configs.
