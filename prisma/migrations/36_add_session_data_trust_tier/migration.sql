ALTER TABLE "session_data"
ADD COLUMN "trust_tier" SMALLINT NOT NULL DEFAULT 0;

ALTER TABLE "session_data"
ADD CONSTRAINT "session_data_trust_tier_check" CHECK ("trust_tier" IN (0, 1));
