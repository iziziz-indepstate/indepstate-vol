# nDate History Overlays

The nDate skew widgets can overlay selected historical option-chain snapshots on top of the current snapshot. This is useful when `S` is set to `ATM`, because the selected ATM anchor can move during the session and each snapshot can otherwise produce a different strike ladder.

## Scope

History overlays apply to the nDate snapshot-series widgets:

- `nDate-Skew-Put`
- `nDate-Skew-Call`
- `nDate-Skew-Bid-Put`
- `nDate-Skew-Bid-Call`
- velocity variants built from the same generic nDate engine

The renderer stores the selected historical snapshot times in each widget config as `historySnapshotTimes`.

## History Panel

Each nDate widget has an `H` button. It opens a side panel with historical snapshots for the current tab.

- Checking a snapshot overlays that historical series on the chart.
- Ctrl-clicking `H` propagates the selected snapshots and history display settings to the other nDate skew widgets on the tab.
- `delete unselected` keeps the latest snapshot and the currently selected historical snapshots, then removes the rest from the tab history.

When multiple historical snapshots are selected, each snapshot gets a stable color based on selection order. The same color is used for:

- the dashed historical line on the chart
- the row marker and text in the history panel

Historical lines are intentionally hidden from the chart legend. The history panel is the legend for historical snapshots. The chart legend remains focused on current base series, such as separate expiries.

## Single vs Multiple Snapshots

With one selected historical snapshot, the historical line uses the corresponding current base-series color. This keeps current-vs-past comparison readable for one snapshot.

With two or more selected historical snapshots, colors are assigned by selection order:

1. First selected snapshot gets the first history color.
2. Second selected snapshot gets the next history color.
3. Existing selected snapshots keep their colors when another snapshot is added.

This avoids color reassignment when selecting additional snapshots.

## Common Strike Range

The `common strike range` checkbox normalizes the x-axis and line construction for current plus selected historical snapshots.

Without this option, each series is built from the widget's normal `SR` strike pattern. If `S = ATM`, different snapshots can use different anchors, and historical overlays can extend beyond the current line.

With this option enabled:

1. The normal `SR` rule is first applied to the current snapshot and all selected historical snapshots.
2. The renderer calculates an outer strike range:
   - minimum displayed strike = the lowest strike produced by any selected current/history series
   - maximum displayed strike = the highest strike produced by any selected current/history series
3. The current snapshot and selected historical snapshots are rebuilt over every available strike inside that outer range.
4. The rebuilt lines are rendered as point data, so missing labels do not create artificial breaks.

The important rule is that `SR` defines the initial limits, while history common-range mode fills the range densely, one available strike at a time, instead of stopping at the default 10 SR points or keeping SR skips.

## Hide Current

The `hide current` checkbox hides the current base series while leaving selected historical snapshots visible. This is intended for comparing two or more historical snapshots directly.

If a current base series is hidden through the chart legend, its historical overlays remain hidden as well. `hide current` does not re-enable history for an expiry that the user already hid.

## Implementation Notes

- UI state and rendering live in `src/renderer/app.js`.
- nDate strike selection is implemented in `src/renderer/widgets/ndate-skew-generic.js`.
- Dense history range rebuilds pass `historyStrikeRangeBounds` through the widget config only for rendering. This is not a persisted user control.
- Snapshot-series data is converted to Chart.js point data (`{ x, y }`) before rendering overlays. This prevents unrelated series labels from injecting `null` gaps into otherwise continuous lines.
