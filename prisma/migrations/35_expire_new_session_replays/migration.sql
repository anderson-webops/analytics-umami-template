ALTER TABLE "session_replay" ADD COLUMN "retention_expires_at" TIMESTAMPTZ(6);
ALTER TABLE "session_replay" ALTER COLUMN "retention_expires_at" SET DEFAULT CURRENT_TIMESTAMP + INTERVAL '30 days';

CREATE INDEX "session_replay_retention_expires_at_idx"
ON "session_replay"("retention_expires_at")
WHERE "retention_expires_at" IS NOT NULL;

ALTER TABLE "session_replay_saved" ADD COLUMN "retention_expires_at" TIMESTAMPTZ(6);

CREATE INDEX "session_replay_saved_retention_expires_at_idx"
ON "session_replay_saved"("retention_expires_at")
WHERE "retention_expires_at" IS NOT NULL;
