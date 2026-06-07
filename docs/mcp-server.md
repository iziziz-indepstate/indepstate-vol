# MCP Server

IS-VOL starts a localhost-only MCP server while the Electron app is running.

Default endpoint:

```text
http://127.0.0.1:37373/mcp
```

Set `IS_VOL_MCP_PORT` before launching the app to use another port.

The MCP server is a proxy to the currently open UI runtime. It returns dashboard tabs, widgets, and widget datasets that the UI has already loaded/rendered. It does not refresh market data, switch tabs, or recompute widget data outside the renderer.

## Tools

- `get_app_info`: describes the app, current active dashboard, and UI-runtime data semantics.
- `list_dashboards`: lists dashboard tabs and loaded widget-data counts.
- `list_widgets`: lists widgets in a tab with config, widget metadata, and runtime data status.
- `get_widget_data`: returns the current dataset for a widget, or an explicit missing/not-loaded response.

Widgets whose tabs have not been opened/rendered in the current UI session can report `not_loaded`.
