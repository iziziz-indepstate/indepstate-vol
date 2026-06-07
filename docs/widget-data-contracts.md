# Widget Data Contracts

Widgets can act as derived data sources inside the dashboard.

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

## Implementation Notes

- The widget data store is local to the renderer runtime.
- Full dashboard refresh renders producer table widgets before widget-data consumers.
- When a `Straddle ATM` config changes, dependent `Vol Upfront` widgets are refreshed after the source output is republished.
- Exact persistence of widget outputs is intentionally not implemented yet; outputs are recalculated from current snapshots and widget configs.
