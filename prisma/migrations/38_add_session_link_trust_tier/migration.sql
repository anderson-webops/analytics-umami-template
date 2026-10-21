ALTER TABLE "session_link"
ADD COLUMN "trust_tier" SMALLINT NOT NULL DEFAULT 0;

ALTER TABLE "session_link"
ADD CONSTRAINT "session_link_trust_tier_check" CHECK ("trust_tier" IN (0, 1));
