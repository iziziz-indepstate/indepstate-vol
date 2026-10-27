# Multi-Expiry Skew

`Multi-Expiry Skew` plots put-minus-call IV skew for several fixed expiration dates on a chronological time axis. It uses the selected tab's TradingView datasource and does not request chains outside that datasource's configured expiry range.

## Controls and calculation

- `D`: shared absolute delta, default `0.25`, range `0.01–0.49`.
- `Expirations`: add or remove fixed dates. A new widget starts with no dates. Duplicate dates produce one series.
- `From / To`: inclusive trading-date filters; empty bounds show all saved history. Trading dates use `America/New_York`, while chart times and tooltips use the computer's local timezone.

Each expiration plots only `IV put(−D) − IV call(+D)`, in volatility points. For example, 24% put IV minus 20% call IV gives +4 vol pts. There are no separate wing-minus-ATM lines; an ATM pair is not required. The chart includes a zero line and a clickable legend with values on hover. Detailed contract information is retained in the archive without a text dump beneath the chart.

Quote validation, strictly OTM contract selection and interpolation reuse [0DTE Skew](zero-dte-skew.md). There is no extrapolation or fallback to another expiration. Missing data and New York trading-day boundaries break the lines. Expired dates remain available for viewing their recorded history.

## Recording and recovery

Recording is always enabled for configured dates. Points are calculated as each datasource snapshot arrives, before compact history or `keepPoints` can remove quotes. Recording continues on inactive tabs while their datasource is polling. Opening or reconfiguring the widget also backfills from available datasource history. Compact history preserves quotes for all configured expirations.

Daily versioned JSON files are stored in:

```text
Documents/IS-VOL/Data/Skew
```

History identity is `{ dataSourceId, symbol, expiration, targetDelta }`. The symbol comes from the datasource ticker (or root when no ticker is set). Widget IDs are excluded, so equivalent widgets share history without duplicating points. Different datasources, symbols, expirations and deltas are isolated. Returning to a previous delta restores its history; only still-available snapshots can be recalculated for a new delta.

Each document stores its kind (`multi-expiry-skew-history`), version (`1`), New York trading date, identity, update timestamp and compact points. Points contain timestamp, expiration, session date, target delta, skew, put/call IV and interpolation contracts, plus any missing-data warning. Full option chains are not archived. Missing observations are retained as null-skew gap markers; they cannot replace valid points at the same timestamp.

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

Tests cover calculations, compact history, gaps, identity isolation, concurrent writes, recovery, retries and recording from inactive tabs. Existing 0DTE Skew behavior is unchanged.
