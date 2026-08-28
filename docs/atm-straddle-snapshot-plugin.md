# ATM Straddle Snapshot Plugin

The `atm-straddle-snapshot` plugin saves selected `Straddle ATM` widget outputs to daily JSON files.

The widget still owns only the ATM straddle calculation and its normal `atm-straddle` structured output. Snapshot persistence is an optional plugin side effect triggered by the widget's point event.
The plugin also provides read-only display widgets for the saved daily files.

## Files

- Renderer manifest: `src/plugins/atm-straddle-snapshot/manifest.js`
- Renderer listener: `src/plugins/atm-straddle-snapshot/listener.js`
- Renderer display widgets: `src/plugins/atm-straddle-snapshot/widgets.js`
- Renderer extension helpers: `src/renderer/widget-extensions.js`
- Renderer event bus: `src/renderer/widget-event-bus.js`
- Main-process store: `src/main/atm-straddle-snapshot-store.cjs`
- IPC boundaries: `atm-straddle-snapshot:save`, `atm-straddle-snapshot:load`

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

## Save Event

`Straddle ATM` emits `atm-straddle:point` for graph-eligible points in its straddle price history that have not yet been emitted during the current renderer session. This includes reconstructed history points, so inactive-tab gaps can be backfilled when the widget renders again.

Event payload:

```ts
type AtmStraddlePointEventPayload = {
  time: string | number
  value: number
  straddlePts: number
  atmStrike: number
  referencePrice: number
  spot: number
  impliedMovePct?: number
  atmIv?: number
  title: string
  config: AtmStraddleWidgetConfig
  widget: {
    id: string
    type: "atm-straddle"
    title?: string
    config: AtmStraddleWidgetConfig
  }
  snapshot: AtmStraddleSnapshot
}
```

The listener saves only when every condition is true:

- event type is `atm-straddle:point`
- source widget type is `atm-straddle`
- widget plugin setting `enabled` is `true`
- event point has valid `time`, finite `straddlePts`, finite `atmStrike`, and finite `referencePrice`
- `window.appBridge.saveAtmStraddleSnapshot` is available

Wrong widget types, disabled widgets, and incomplete point events are ignored.

## Published Widget Output Contract

`Straddle ATM` still publishes its normal structured widget data output:

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

The snapshot plugin no longer persists from this generic data output. It persists from `atm-straddle:point` so the save path matches the point creation path.

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
  sourceSnapshotTime: string | number
})
```

`sourceSnapshotTime` is the event point's `time`. The main process handles this through `atm-straddle-snapshot:save` and delegates filesystem work to `src/main/atm-straddle-snapshot-store.cjs`.

## Load IPC Contract

The display widgets call:

```ts
window.appBridge.loadAtmStraddleSnapshots({
  tenor: string,
  startDate?: string,
  endDate?: string
})
```

The main process handles this through `atm-straddle-snapshot:load`, reads from the same snapshot directory, and returns:

```ts
type AtmStraddleSnapshotLoadResult = {
  ok: true
  directory: string
  documents: LoadedAtmStraddleDailySnapshotDocument[]
  warnings: Array<{
    file: string
    message: string
  }>
}
```

`documents[]` follows the stored snapshot data contract below and adds source metadata:

```ts
source: {
  file: string
  filename: string
}
```

A missing directory returns an empty `documents` list. Malformed files and files with the wrong `kind` are skipped and reported in `warnings`.

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

## Display Widgets

The plugin exposes two widget definitions through its renderer manifest. They are registered in the app's normal widget registry alongside built-in renderer widgets.

### Straddle Daily Price

Type: `straddle-daily-price`

Controls:

- collapsible `Lines` settings panel
- each line has `Tenor` and `Time`
- the default line is `0DTE @ 16:45`
- `Add line` duplicates the last configured line
- at least one line is kept
- time values are plain `HH:mm` text fields

Behavior:

- loads saved daily snapshot documents for the unique tenors used by configured lines
- matches each line's documents by local `HH:mm`, ignoring seconds and milliseconds
- draws one dataset per configured line
- each dataset draws one point per matched day with x = document date and y = `straddlePts`
- skips any day/line without an exact local minute match
- tooltip metadata includes point time, ATM strike, spot, straddle points, source file, and date
- publishes structured widget output with `type: "straddle-daily-price"`, config, warning list, document count, and rendered series

Config:

```ts
type StraddleDailyPriceConfig = {
  lines: Array<{
    tenor: string
    time: string
  }>
}
```

Legacy `{ tenor, time }` configs are read as a single line and are replaced by `lines[]` after line edits.

### Straddle Dynamics

Type: `straddle-dynamics`

Controls:

- `Tenor`: defaults to `0DTE`
- `From`: optional start date
- `To`: optional end date
- `Start time`: optional local intraday lower bound as plain `HH:mm` text
- `End time`: optional local intraday upper bound as plain `HH:mm` text

Behavior:

- loads saved daily snapshot documents filtered by tenor and optional date range
- filters points by optional local `HH:mm` time range
- empty `Start time` means no lower time bound
- empty `End time` means no upper time bound
- draws one dataset per day
- x-axis is local intraday `HH:mm`
- y-axis is `straddlePts`
- tooltip metadata includes original timestamp, ATM strike, spot, source file, and date
- empty date range means all available matching documents
- publishes structured widget output with `type: "straddle-dynamics"`, config, warning list, document count, and rendered series

## Tests

Relevant tests:

- `test/atm-straddle-snapshot-plugin.test.mjs`
- `test/atm-straddle-snapshot-widgets.test.mjs`
- `test/widget-extensions.test.mjs`
- `test/widget-data-publish-bus.test.mjs`
- `test/atm-straddle-snapshot-store.test.cjs`
