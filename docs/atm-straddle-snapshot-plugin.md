# ATM Straddle Snapshot Plugin

The `atm-straddle-snapshot` plugin saves selected `Straddle ATM` widget outputs to daily JSON files.

The widget still owns only the ATM straddle calculation and its normal `atm-straddle` structured output. Snapshot persistence is an optional plugin side effect.

## Files

- Renderer manifest: `src/plugins/atm-straddle-snapshot/manifest.js`
- Renderer listener: `src/plugins/atm-straddle-snapshot/listener.js`
- Renderer extension helpers: `src/renderer/widget-extensions.js`
- Renderer publish bus: `src/renderer/widget-data-publish-bus.js`
- Main-process store: `src/main/atm-straddle-snapshot-store.cjs`
- IPC boundary: `atm-straddle-snapshot:save`

## Widget Extension

The plugin registers one widget extension control:

```ts
{
  name: "enabled",
  type: "checkbox",
  label: "Save snapshot",
  defaultValue: false
}
```

It applies only when both the widget and widget definition type are `atm-straddle`.

Settings are stored per widget:

```json
{
  "config": {
    "plugins": {
      "atm-straddle-snapshot": {
        "enabled": true
      }
    }
  }
}
```

Legacy widget configs are soft-migrated:

- `widget.config.saveSnapshot === true` becomes `widget.config.plugins["atm-straddle-snapshot"].enabled = true`
- `widget.config.saveSnapshot === false` or a missing field does not enable the plugin
- the legacy `saveSnapshot` field is deleted during widget config normalization

## Save Conditions

The listener saves only when every condition is true:

- widget type is `atm-straddle`
- widget definition type is `atm-straddle`
- published output type is `atm-straddle`
- published output status is `ok`
- widget plugin setting `enabled` is `true`
- output snapshot has finite `atmStrike`, `referencePrice`, and `straddle.mid`
- `window.appBridge.saveAtmStraddleSnapshot` is available

Wrong widget types, wrong output types, disabled widgets, error outputs, and incomplete snapshots are ignored.

## Published Widget Output Contract

The plugin listens to the normal `Straddle ATM` widget data output:

```ts
type AtmStraddleWidgetOutput = {
  type: "atm-straddle"
  status: "ok" | "error"
  title: string
  config: AtmStraddleWidgetConfig
  snapshot?: AtmStraddleSnapshot
  priceHistory?: AtmStraddlePricePoint[]
  error?: string
  tabId: string
  widgetId: string
  updatedAt: string
}
```

Only `status: "ok"` outputs with a saveable `snapshot` are persisted.

The minimum saveable snapshot fields are:

```ts
type SaveableAtmStraddleSnapshot = {
  symbol?: string
  tenor?: string
  expiry?: string
  dte?: number
  snapshotTime?: string | number
  time?: string | number
  atmStrike: number
  referencePrice: number
  atmSelectionMethod?: string
  straddle: {
    mid: number
  }
}
```

The full `AtmStraddleSnapshot` produced by `src/shared/atm-straddle-calculations.mjs` may include call/put quote details, implied move, expected range, ATM IV, Greeks, comparison, state labels, and quality flags. The persisted daily file intentionally stores only identity, summary, and compact time-series points.

## Save IPC Payload

The renderer listener calls:

```ts
window.appBridge.saveAtmStraddleSnapshot({
  title: string,
  config: AtmStraddleWidgetConfig,
  snapshot: AtmStraddleSnapshot,
  sourceSnapshotTime: string | number | null
})
```

The main process handles this through `atm-straddle-snapshot:save` and delegates filesystem work to `src/main/atm-straddle-snapshot-store.cjs`.

## Stored File Location

Files are written under:

```text
Documents/IS-VOL/Data/Straddle-ATM
```

The file name is stable for one daily identity:

```text
atm-straddle_<date>_<symbol>_<expiry>_<tenor>_<identityHash>.json
```

The identity hash is based on:

```ts
{
  symbol: string
  tenor: string
  expiry: string
  atmStrikeOverride: string
  manualReferencePrice: string
  referencePriceMode: string
  quoteMode: string
}
```

## Stored Snapshot Data Contract

Each persisted JSON document has this shape:

```ts
type AtmStraddleDailySnapshotDocument = {
  kind: "atm-straddle-daily-snapshot"
  version: 1
  date: string
  identity: {
    symbol: string
    tenor: string
    expiry: string
    atmStrikeOverride: string
    manualReferencePrice: string
    referencePriceMode: string
    quoteMode: string
  }
  summary: {
    title: string
    expiry: string
    dte: number | null
    atmSelectionMethod: string | null
  }
  updatedAt: string
  points: AtmStraddleSnapshotPoint[]
}

type AtmStraddleSnapshotPoint = {
  time: string | number
  atmStrike: number
  spot: number
  straddlePts: number
}
```

Daily upsert behavior:

- one file is used per date and identity
- a new point is appended when its `time` is new
- an existing point with the same `time` is replaced
- points are sorted by time after each save
- concurrent writes to the same file are serialized by the main-process store

## Tests

Relevant tests:

- `test/atm-straddle-snapshot-plugin.test.mjs`
- `test/widget-extensions.test.mjs`
- `test/widget-data-publish-bus.test.mjs`
- `test/atm-straddle-snapshot-store.test.cjs`
