ALTER TABLE "heatmap_event" ADD COLUMN "retention_expires_at" TIMESTAMPTZ(6);
ALTER TABLE "heatmap_event" ALTER COLUMN "retention_expires_at" SET DEFAULT CURRENT_TIMESTAMP + INTERVAL '30 days';

CREATE INDEX "heatmap_event_retention_expires_at_idx"
ON "heatmap_event"("retention_expires_at")
WHERE "retention_expires_at" IS NOT NULL;
