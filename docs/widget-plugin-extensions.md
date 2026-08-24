# Widget Plugin Extensions

Renderer app plugins can add opt-in controls and data listeners around widgets without moving side effects into widget implementations.

This is separate from widget event contracts:

- widget events are interaction-driven, such as chart point clicks
- widget data publish events are render/data-driven, such as a table widget publishing its structured output
- widget extensions add per-widget plugin controls in the widget card header

## Manifest Contract

A renderer plugin manifest may register widget extensions:

```ts
type WidgetExtensionControl = {
  name: string
  type: "checkbox" | "text" | "number"
  label?: string
  title?: string
  defaultValue?: unknown
}

type WidgetExtension = {
  settingsKey?: string
  controls: WidgetExtensionControl[]
  appliesTo(widget: WidgetConfig, definition: WidgetDefinition): boolean
  migrateConfig?(context: {
    widget: WidgetConfig
    pluginId: string
  }): void
}

type AppPluginManifest = {
  id: string
  title?: string
  widgetExtensions?: WidgetExtension[]
  activate?(context: AppPluginContext): void | (() => void)
}
```

The manifest is imported through `src/plugins/index.js`. `createWidgetCard` renders applicable controls in the widget header, next to built-in widget controls.

## Settings Storage

Extension settings are stored on the widget under the owning plugin id:

```json
{
  "config": {
    "plugins": {
      "plugin-id": {
        "enabled": true
      }
    }
  }
}
```

The current helper path is:

- `src/renderer/widget-extensions.js`
- `src/renderer/widgets/widget-renderers.js`
- `src/renderer/app.js`

Use `settingsKey` as extension metadata when needed, but persisted settings are keyed by `pluginId` so one plugin owns one widget-scoped config object.

## Migration Hooks

`migrateConfig` runs during widget normalization in `renderWidgets`. It is intended for soft migrations from legacy widget-owned fields into plugin settings.

Migration rules:

- migrate only fields owned by the extension
- preserve explicit enabled/disabled intent
- delete migrated legacy fields so future saves use `widget.config.plugins`
- catch failures at the app layer so one plugin cannot break widget rendering

## Control Handling

The app normalizes basic control values:

- checkbox controls become booleans
- number controls become finite numbers or `""`
- text controls become strings

After a control changes, the dashboard UI state is persisted. Extension controls should generally not force widget re-rendering unless the plugin needs a separate explicit refresh path.

## Widget Data Publish Events

When a widget publishes structured data, `publishWidgetData` stores it in the renderer widget data store and MCP runtime store, then notifies plugin subscribers.

The subscriber payload is:

```ts
type WidgetDataPublishEvent = {
  tab: TabConfig | null
  widget: WidgetConfig | null
  definition: WidgetDefinition | null
  output: object | null
  sourceSnapshotTime: string | number | null
}
```

Subscribers attach through the plugin activation context:

```ts
type AppPluginContext = {
  eventBus: WidgetEventBus
  widgetDataEvents: {
    subscribe(handler: (event: WidgetDataPublishEvent) => void | Promise<void>): () => void
  }
  getWidgetDefinition(type: string): WidgetDefinition | null
  appBridge: WindowAppBridge
  clipboard: {
    writeText(text: string): Promise<void>
  }
  setStatus(text: string): void
}
```

Subscriber failures are caught and logged by the publish bus. They must never block widget rendering, widget data storage, or MCP runtime publication.

## Current Built-In Extensions

- `atm-straddle-snapshot`: adds `Save snapshot` to `Straddle ATM` widgets and saves valid `atm-straddle` data outputs through the existing main-process IPC boundary.
