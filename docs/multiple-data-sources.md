# Multiple data sources per tab

A dashboard tab can contain widgets from TradingView, The Block, and Tape Contract together. Each tab holds at most one source per provider. Sources are private to their tab.

Adding a widget automatically creates its source if needed and opens that source's settings in **Data**. Use the **Data source** selector to switch between configurations. Each source has its own polling interval, history limit, raw snapshot and compaction settings, and lifecycle schedule. Removing a widget keeps its source and settings.

**Start**, **Stop**, **Refresh once**, and **Clear snapshot history** apply to all sources in the active tab. Polling intervals and failures are independent. A yellow indicator means only some sources are running, for example because their schedules differ. Adding a new source while any source is running starts it immediately; otherwise it stays stopped.

TradingView supplies the option-chain widgets. Tape Contract supplies Option Flow TICK, Balanced TICK, Gamma Flow, and Gamma Imbalance. The Block supplies its market charts. Vol Upfront consumes published widget data; Straddle Daily Price and Straddle Dynamics read saved snapshot files. SPX IV / RV manages its own market-data inputs. These independent widgets do not create dashboard sources.

Snapshots and history are isolated per source. Requests collect expiry placeholders and compact snapshots using only the widgets belonging to that source. Clearing history also clears computed widget outputs; late responses from before a clear or configuration change cannot restore obsolete data. Source configuration changes invalidate outstanding requests.

## Saved configuration and integrations

Existing single-source tabs migrate automatically on load, keeping their tab IDs, widget IDs, provider settings, and lifecycle settings. Missing sources for other widget types are added once. Configuration now stores `tabs[].dataSources[]` entries with `id`, `providerKey`, and `providerConfig`. Source selection in Data is a session-only UI preference. Histories remain session-only, as before.

Datasource IPC commands use `{ tabId, command, dataSourceId? }`. Omitting `dataSourceId` runs a command for the entire tab; schedules target a single source. Lifecycle settings and configuration patches carry both identifiers. Lifecycle UI entries and running-source IDs are keyed by source ID.

MCP dashboard descriptions expose `dataSources`; widget descriptions include their automatically resolved `dataSourceId` (null for independent widgets), and definitions expose `providerKey`. Widget-reading methods and tab/widget identifiers retain their existing meaning. Raw snapshot filenames include the source identity to distinguish providers in the same tab.

Multiple configurations of one provider and manual widget-to-source binding are not supported.
