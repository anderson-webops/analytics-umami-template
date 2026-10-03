CREATE TABLE "replay_ingest_budget" (
    "website_id" UUID NOT NULL,
    "scope" VARCHAR(6) NOT NULL,
    "scope_key" VARCHAR(64) NOT NULL,
    "bytes" BIGINT NOT NULL DEFAULT 0,
    "events" INTEGER NOT NULL DEFAULT 0,
    "chunks" INTEGER NOT NULL DEFAULT 0,
    "chunk_indices" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
    "expires_at" TIMESTAMPTZ(6),

    CONSTRAINT "replay_ingest_budget_pkey" PRIMARY KEY ("website_id","scope","scope_key"),
    CONSTRAINT "replay_ingest_budget_scope_check" CHECK ("scope" IN ('visit', 'minute', 'day')),
    CONSTRAINT "replay_ingest_budget_nonnegative_check" CHECK ("bytes" >= 0 AND "events" >= 0 AND "chunks" >= 0),
    CONSTRAINT "replay_ingest_budget_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "website"("website_id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "replay_ingest_budget_expires_at_idx" ON "replay_ingest_budget"("expires_at");
