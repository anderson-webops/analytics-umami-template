ALTER TABLE "website_event"
ADD COLUMN "trust_tier" SMALLINT NOT NULL DEFAULT 0;

ALTER TABLE "website_event"
ADD CONSTRAINT "website_event_trust_tier_check" CHECK ("trust_tier" IN (0, 1));

ALTER TABLE "event_data"
ADD COLUMN "trust_tier" SMALLINT NOT NULL DEFAULT 0;

ALTER TABLE "event_data"
ADD CONSTRAINT "event_data_trust_tier_check" CHECK ("trust_tier" IN (0, 1));
