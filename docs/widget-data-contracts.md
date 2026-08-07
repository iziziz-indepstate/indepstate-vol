# Widget Data Contracts

Widgets can act as derived data sources inside the dashboard.

For interaction events, use the parallel event contract architecture described in [Widget Event Contracts](widget-event-contracts.md).

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

## Implementation Notes

- The widget data store is local to the renderer runtime.
- Full dashboard refresh renders producer table widgets before widget-data consumers.
- When a `Straddle ATM` config changes, dependent `Vol Upfront` widgets are refreshed after the source output is republished.
- Exact persistence of widget outputs is intentionally not implemented yet; outputs are recalculated from current snapshots and widget configs.
