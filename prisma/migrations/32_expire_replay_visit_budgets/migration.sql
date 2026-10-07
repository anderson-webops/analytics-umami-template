UPDATE "replay_ingest_budget"
SET "expires_at" = now() + INTERVAL '38 days'
WHERE "scope" = 'visit' AND "expires_at" IS NULL;
