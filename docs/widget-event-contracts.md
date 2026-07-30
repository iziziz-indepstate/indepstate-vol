# Widget Event Contracts

Widgets can publish interaction events through a renderer-local event bus. This is the event-side counterpart to widget data contracts: widgets declare what they can emit, and app-level subscribers decide what side effects to perform.

## Core Concepts

- **Event contract**: widget definition metadata that lists supported event types and payload fields.
- **Event source**: the bus-side registration for one producer, usually one rendered widget chart.
- **Event port**: the narrow interface passed to producer code. It exposes only `emit`, `hasInterest`, `onInterestChange`, and `destroy`.
- **Subscriber**: app-level logic that listens for event types and performs side effects.
- **Plugin**: a manifest-backed app extension that initializes subscribers, services, or other event/data integrations.

The chart renderer does not receive the whole bus. It receives an event port, so it cannot inspect or manage subscribers directly.

## Demand-Driven Emission

Event production is demand-driven. A source emits only when both conditions are true:

- the widget definition declares the event type
- the bus currently has at least one subscriber for that event type

The bus notifies registered event ports when subscriber interest appears or disappears. Producers use that signal to avoid expensive work such as chart hit-testing when nobody is listening.

```text
subscriber -> bus.subscribe("chart.pointClick", handler)
bus -> eventPort.onInterestChange("chart.pointClick", true)
chart -> eventPort.emit("chart.pointClick", payload)
bus -> subscriber handler receives enriched event
```

## Event Shape

An emitted event is enriched by the source registration:

```ts
type WidgetEvent = {
  type: string
  tabId: string | null
  widgetId: string | null
  widgetType: string | null
  timestamp: string
  payload: object
}
```

For chart point clicks, the payload currently includes:

```ts
{
  strike: string | number
  label: string
  value: number
  datasetLabel: string
  datasetIndex: number
  pointMeta?: object | null
}
```

## nDate Strike Clipboard Listener

The nDate Put/Call skew widgets declare `chart.pointClick`. Their widget definitions also expose a clipboard strategy:

- put-side widgets use `sps`
- call-side widgets use `lcs`

The clipboard command is not implemented inside the widget or chart renderer. It lives in the `ndate-strike-clipboard` app plugin, which subscribes to two point-click events from the same widget within 20 seconds, then writes `sps <strike1> <strike2>` or `lcs <strike1> <strike2>` to the clipboard.

Historical overlay datasets are ignored by the point-click producer.

## App Plugins

Plugins are first-class consumers of widget data and widget events. A plugin lives under `src/plugins/<plugin-id>/` and exposes a `manifest.js` module.

The manifest is the plugin's initialization contract:

```ts
type AppPluginManifest = {
  id: string
  title?: string
  eventSubscriptions?: string[]
  activate(context: AppPluginContext): void | (() => void)
}
```

The app imports manifests through `src/plugins/index.js` and activates them with a context object:

```ts
type AppPluginContext = {
  eventBus: WidgetEventBus
  getWidgetDefinition(type: string): WidgetDefinition | null
  clipboard: {
    writeText(text: string): Promise<void>
  }
  setStatus(text: string): void
}
```

Plugin files may include listeners, services, helpers, or state machines beside the manifest. Keep the manifest as the assembly layer: it imports plugin-local pieces, reads the app context, and wires the plugin into the app. This keeps widgets focused on producing data/events, while plugins own optional workflows and side effects.

## Implementation Notes

- The event bus is renderer-local and in-memory.
- Events are not persisted.
- Event contracts are serialized with widget definitions for MCP/open-runtime inspection.
- Event port cleanup belongs to the chart/widget lifecycle; destroyed ports do not emit or receive interest changes.
- Plugin activation is explicit through the manifest registry; plugin side effects should clean up by returning a function from `activate`.
