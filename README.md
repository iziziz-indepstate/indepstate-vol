# indepstate-vol

Electron dashboard for volatility analytics with pluggable data providers and pluggable widgets.

## Run

```bash
npm install
npm start
```

## Current implementation

- **Provider abstraction**: `providers[providerKey]` map in renderer. Right now includes `TradingViewProvider` only.
- **Widget abstraction**: each widget lives in `src/renderer/widgets/` as a separate script file, composed via a central registry.
- **Metric abstraction**: metric definitions (`key` + `compute`) live in `src/renderer/widgets/metrics.js` and are passed into providers for calculation.
- **Dashboard tabs**: each tab stores its own provider config and list of widgets.
- **State persistence**: tab layout + config are saved to Electron `userData/dashboard-state.json` and restored on next launch.

## Included widgets

- ATM Call-Put Skew (`dAtm = callATM.iv - putATM.iv`)
- ±3 Strike Put-Call Skew (`dTail = put(-steps).bid_iv - call(+steps).bid_iv`)
- nDate-Put-Skew (изменение `put bid_iv` по пользовательской лесенке страйков от заданного уровня, с отдельными `expiry` и `ticker` в самом виджете)
- nDate-Call-Skew (аналогично nDate-Put-Skew, но по `call bid_iv` и лесенка страйков вверх от указанного страйка)
