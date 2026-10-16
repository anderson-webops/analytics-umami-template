# Historical ClickHouse table copies

Early optional ClickHouse migrations retained old event, event-data and hourly
summary tables. One migration also left a session-to-visit join table. These
copies are outside the current collection-source deletion path and may retain
data for a source that was later reset or deleted. Do not rewrite the applied
migrations, assume the copies are absent, or drop tables as a source-code deploy.

Using the repository-pinned Node 24 runtime,
`node scripts/inspect-legacy-clickhouse-tables.mjs` is a read-only, bounded
inventory. The protected server operator may run it with the existing private
`CLICKHOUSE_URL`; source agents must not connect to the server or request that
value. It reports only exact historical table names, storage engines, approximate
row/byte counts, schema shape, and a digest of the inventory. It does not read
analytics rows, change data, or include connection details in its output. An
empty or incomplete inventory is not evidence that prior deleted data is gone.
The historical SQL names the `umami` database explicitly; an inventory using a
different database remains review-required rather than declaring the old copies
absent.

Before any cleanup, the operator must establish the exact ClickHouse database
and applied migration history, quiesce writers, take and restore-test a protected
backup, compare active data and retained-runtime recovery requirements, and
review every listed legacy object and any dependencies. In particular,
`website_event_join` has no `website_id` and cannot be safely erased per source;
the old materialized view also needs dependency review. The operator must decide
whether whole-table retirement is authorized after the active replacement and
rollback evidence are verified. A changed inventory digest, missing active
table, unexpected engine, or surviving dependency requires a new review.

Cleanup is a separate protected, reviewed database operation, not an automatic
runtime migration. Repeat the inventory and source-deletion acceptance after
cleanup, verify the retired copies and affected tenant data are absent, and
preserve the exact retained-release recovery evidence. Do not count the
historical-data finding complete from this source inventory alone.
