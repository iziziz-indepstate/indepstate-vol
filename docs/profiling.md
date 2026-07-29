# Profiling

IS-VOL includes a lightweight internal profiler for diagnosing live-session stalls.

The profiler is disabled by default. Enable it only when collecting diagnostics:

```powershell
npm start -- --profile
```

Packaged builds can also use an environment variable:

```powershell
$env:IS_VOL_PROFILER = '1'
npm start
```

## Export a profile

1. Start IS-VOL with profiling enabled.
2. Let the dashboard run until the lag or slow tick happens.
3. Press `Ctrl+Shift+P` inside the app.
4. The status line shows the exported JSON path under Electron `userData`.

The same actions are available from the renderer console:

```js
window.isVolProfiler.enabled()
window.isVolProfiler.summary()
window.isVolProfiler.export()
window.isVolProfiler.clear()
```

## What is measured

- Renderer tick stages: datasource fetch, snapshot trim, active-tab render trigger, total tick time.
- Renderer rendering: full chart refreshes, per-widget chart refreshes, table widget renders.
- Persistence: history point append, full state saves, scheduled disk flushes.
- Main process datasource and I/O: TradingView snapshots, The Block snapshots, daily market history, raw snapshot saves.

The profiler keeps events in memory and writes a file only when exported. History state still uses normal low-priority scheduled persistence.
