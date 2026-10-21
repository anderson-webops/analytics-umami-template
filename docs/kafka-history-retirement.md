# Kafka collection history and destructive operations

This release refuses production Kafka collection. Source reset, source deletion,
and session deletion also fail closed until the protected host configuration sets
`KAFKA_HISTORY_ATTESTED_CLEAN=true`. The current absence of `KAFKA_URL` and
`KAFKA_BROKER` is not proof that an earlier producer, external consumer, or
retained broker record cannot recreate deleted data. Application source agents
must not set this value or connect to production to obtain it.

Session deletion additionally requires the existing
`CLICKHOUSE_HISTORY_ATTESTED_CLEAN=true` review when the current ClickHouse URL
is absent. Both historical stores can outlive their current configuration.

The server operator may set the flag only after a protected, read-only review
establishes the exact producer and consumer history, all relevant topics and
retention, in-flight records, retained backups, external sinks, and whether a
consumer can still resume. Any pre-reset or pre-deletion record must be unable
to write again, and historical sinks must be reconciled without guessing tenant
ownership. The reviewed retained rollback release must also be prevented from
re-enabling the old producer or consumer. Unknown history is a failed review,
not permission to set the flag.

Before enabling deletion, rehearse source reset, source deletion, session
deletion, and failed-activation recovery with disposable broker and database
copies. Preserve actual production data, historical migration bytes, and
protected rollback artifacts. If Kafka collection is required again, replace
this retired-mode gate through a reviewed versioned producer/consumer generation
contract and host transition. Never reuse the flag to bypass that contract.
