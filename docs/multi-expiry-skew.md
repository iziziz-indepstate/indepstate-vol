# Skew. Multi-Expiry

`Skew. Multi-Expiry` plots put-minus-call IV skew for several fixed expiration dates in chronological order. Observations are spaced evenly along the X axis, compressing pauses, overnight gaps and weekends. Axis labels and hover times use the actual observation timestamps. It uses the selected tab's TradingView datasource and does not request chains outside that datasource's configured expiry range.

## Controls and calculation

- `D`: shared absolute delta, default `0.25`, range `0.01–0.49`.
- `Settings`: contains the `From / To` date/time filters and expiration dates. The section remembers whether it is expanded or collapsed across refreshes and app restarts. `D` and `Smoothing` remain above it.
- Expiration dates: add or remove fixed dates. A new widget starts with no dates. Duplicate dates produce one series.
- `From / To`: inclusive date filters in the computer's local timezone, matching chart times and tooltips. Empty bounds show all saved history.
- Each date has an optional local time field (including seconds), with daylight saving handled automatically. Time restricts only its corresponding boundary date; without a date it has no effect. Empty times include the whole local boundary day. Boundaries are inclusive; `15:30` means exactly `15:30:00`. Date/time selections are saved per widget, affect display before smoothing and do not delete archived points. Existing saved date/time values are now interpreted as local chart time. Archive files continue using New York trading dates; loading converts the local bounds to archive dates so observations near midnight are retained.
- `Smoothing`: `Linear` (default) shows original values; `Moving average 5 points` and `Moving average 15 points` average the current and previous valid observations independently for each expiration. The selection is saved per widget.

Moving averages use up to 5 or 15 valid points, with partial windows at the beginning and no future observations. Missing values remain missing and do not consume the window. Smoothing starts at the first point within the selected `From / To` range and continues across trading-day boundaries. Chart lines, hover values and published series use the smoothed values; archived observations and series metadata retain the original values. Unknown smoothing settings fall back to `Linear`.

Each expiration plots only `IV put(−D) − IV call(+D)`, in volatility points. For example, 24% put IV minus 20% call IV gives +4 vol pts. There are no separate wing-minus-ATM lines; an ATM pair is not required. The Y axis fits the plotted values with a small margin, without anchoring to zero or drawing a dedicated zero line. The chart includes a clickable legend with values on hover. Detailed contract information is retained in the archive without a text dump beneath the chart.

Legend visibility is saved per widget and expiration date, so hidden lines remain hidden after updates, reordering expirations and app restarts. Hidden lines continue recording and remain included in published series data.

Quote validation, strictly OTM contract selection and interpolation reuse [Skew. 0DTE](zero-dte-skew.md). There is no extrapolation or fallback to another expiration. Lines connect available values across missing observations and New York trading-day boundaries without generating replacement values. Expired dates remain available for viewing their recorded history.

## Recording and recovery

Recording is always enabled for configured dates. Points are calculated as each datasource snapshot arrives, before compact history or `keepPoints` can remove quotes. Recording continues on inactive tabs while their datasource is polling. Opening or reconfiguring the widget also backfills from available datasource history. Compact history preserves quotes for all configured expirations.

Daily versioned JSON files are stored in:

```text
Documents/IS-VOL/Data/Skew
```

History identity is `{ dataSourceId, symbol, expiration, targetDelta }`. The symbol comes from the datasource ticker (or root when no ticker is set). Widget IDs are excluded, so equivalent widgets share history without duplicating points. Different datasources, symbols, expirations and deltas are isolated. Returning to a previous delta restores its history; only still-available snapshots can be recalculated for a new delta.

Each document stores its kind (`multi-expiry-skew-history`), version (`1`), New York trading date, identity, update timestamp and compact points. Points contain timestamp, expiration, session date, target delta, skew, put/call IV and interpolation contracts, plus any missing-data warning. Full option chains are not archived. Missing observations are retained as null-skew records with warnings even though the plotted lines span them; they cannot replace valid points at the same timestamp.

Files are updated atomically with writes serialized per file. Points are sorted and deduplicated by timestamp; a later valid calculation can update an existing valid point. Datasource resets, history limits and removing widgets or expiration rows do not delete the archive. Reloading the app restores matching files and merges them with current points.

Write failures appear in widget status, retain pending points in memory and retry on subsequent updates. Unsaved points cannot survive terminating the application. Malformed archive files are skipped with warnings; an invalid existing file is preserved rather than overwritten. Dates outside the configured source range show a missing-chain warning when observed. History filters affect display, not recording.

## Integration

The Electron bridge exposes:

```js
saveSkewHistory({ identity, points }) // -> { ok: true }
loadSkewHistory({ identity, startDate?, endDate? })
// -> { ok: true, documents, warnings: [{ file, message }] }
```

IPC channels are `skew-history:save` and `skew-history:load`. The widget publishes structured output with config, series and warnings. Stale asynchronous renders are discarded; charts and resize observers are disposed when replaced or removed.

Tests cover calculations, compact history, gaps, identity isolation, concurrent writes, recovery, retries and recording from inactive tabs. Existing Skew. 0DTE behavior is unchanged.
