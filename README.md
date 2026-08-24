# indepstate-vol

Electron dashboard for volatility analytics with pluggable data providers and pluggable widgets.

The standalone `SPX IV / RV` widget supports interchangeable local, FRED, Cboe, and Yahoo market-data providers. It can run in local, remote, or hybrid cached mode for VIX9D vs SPX RV 9D, VIX vs SPX RV 30D, and custom horizons.

## Run

```bash
npm install
npm start
```

## Current Implementation

- **Provider abstraction**: the renderer keeps a `providers[providerKey]` map. The current live option-chain provider is `TradingViewProvider`.
- **Widget abstraction**: each widget lives in `src/renderer/widgets/` and is composed through the central widget registry.
- **Widget data outputs**: widgets can publish structured outputs for other widgets to consume. This makes derived widgets depend on widget contracts instead of recalculating upstream logic. Details: [Widget Data Contracts](docs/widget-data-contracts.md).
- **Widget events and plugins**: widgets declare interaction event contracts and publish demand-driven events through scoped event ports. App plugins subscribe to those events for side effects such as clipboard commands. Details: [Widget Event Contracts](docs/widget-event-contracts.md).
- **Widget plugin extensions**: renderer plugins can add per-widget controls and subscribe to widget data publish events without moving side effects into widgets. Details: [Widget Plugin Extensions](docs/widget-plugin-extensions.md).
- **nDate generic engine**: put/call nDate widgets are created from one generic parameterized implementation.
- **Metric abstraction**: metric definitions (`key` + `compute`) live in `src/renderer/widgets/metrics.js` and are passed into providers for calculation.
- **Dashboard tabs**: each tab stores its own provider config and widget list.
- **State persistence**: tab layout and config are saved to Electron `userData/dashboard-state.json` and restored on the next launch.
- **Open UI MCP proxy**: while the app is running, agents can inspect loaded dashboard tabs, widgets, and widget datasets through the local MCP endpoint. Details: [MCP Server](docs/mcp-server.md).
- **Profiling**: optional tick/render/I/O profiler for diagnosing live-session stalls. Details: [Profiling](docs/profiling.md).

## Included Widgets

- **Straddle ATM**: text widget for the selected symbol and expiry tenor. It selects expiry, picks the ATM call/put pair, calculates the ATM straddle, implied move, expected range, ATM IV, quote quality, and comparison state. `ATM K` accepts an exact strike or `ATM`. Optional snapshot persistence is provided by the [ATM Straddle Snapshot Plugin](docs/atm-straddle-snapshot-plugin.md). Details: [Straddle ATM Widget](docs/atm-straddle-widget.md).
- **Vol Upfront**: chart and table widget that reads Straddle ATM widgets on the same tab and calculates adjacent forward volatility segments. Details: [Vol Upfront Widget](docs/vol-upfront-widget.md).
- **ATM Call-Put Skew**: time series for `dAtm = callATM.iv - putATM.iv`.
- **+/-3 Strike Put-Call Skew**: time series for `dTail = put(-steps).bid_iv - call(+steps).bid_iv`.
- **nDate Put Skew**: put `bid_iv` by a configurable strike ladder from a base strike, with `E1`, `E2`, and `SR` controls for expiry range and strike pattern. `S` accepts an exact strike or `ATM`. History overlay details: [nDate History Overlays](docs/ndate-history-overlays.md).
- **nDate Call Skew**: call-side counterpart of nDate Put Skew. `S` accepts an exact strike or `ATM`.
- **nDate Skew Bid Put / Call**: nDate skew variants that chart option bid values instead of bid IV. `S` accepts an exact strike or `ATM`.
- **nDate Skew BidIV Ratio**: ratio widget for symmetric strikes around a reference level: `(putBid / putIV) / (callBid / callIV)`. `S` accepts an exact strike or `ATM`.
- **IV Current**: time series for IV at a selected strike. The `S` control accepts an exact strike or `ATM`.
- **Spread Optimizer**: table widget that ranks candidate vertical spreads by configurable risk, liquidity, and regime inputs.
- **SPX IV / RV**: standalone table and chart widget for implied-vs-realized volatility comparisons.

## Tests

```bash
npm test
```
