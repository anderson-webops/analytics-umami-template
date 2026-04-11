ALTER TABLE "session"
ADD COLUMN "is_bot" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "bot_name" VARCHAR(100),
ADD COLUMN "bot_category" VARCHAR(50);

ALTER TABLE "website_event"
ADD COLUMN "is_bot" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "bot_name" VARCHAR(100),
ADD COLUMN "bot_category" VARCHAR(50);

CREATE INDEX "session_website_id_created_at_is_bot_idx"
ON "session"("website_id", "created_at", "is_bot");

CREATE INDEX "website_event_website_id_created_at_is_bot_idx"
ON "website_event"("website_id", "created_at", "is_bot");
