CREATE TABLE "collection_ingest_budget" (
    "subject_type" VARCHAR(8) NOT NULL,
    "subject_key" VARCHAR(64) NOT NULL,
    "scope" VARCHAR(6) NOT NULL,
    "window_start" TIMESTAMPTZ(6) NOT NULL,
    "bytes" BIGINT NOT NULL DEFAULT 0,
    "rows" BIGINT NOT NULL DEFAULT 0,
    "requests" BIGINT NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "collection_ingest_budget_pkey" PRIMARY KEY ("subject_type", "subject_key", "scope", "window_start"),
    CONSTRAINT "collection_ingest_budget_subject_type_check" CHECK ("subject_type" IN ('source', 'user', 'team')),
    CONSTRAINT "collection_ingest_budget_scope_check" CHECK ("scope" IN ('minute', 'day')),
    CONSTRAINT "collection_ingest_budget_nonnegative_check" CHECK ("bytes" >= 0 AND "rows" >= 0 AND "requests" >= 0)
);

CREATE INDEX "collection_ingest_budget_expires_at_idx" ON "collection_ingest_budget"("expires_at");
