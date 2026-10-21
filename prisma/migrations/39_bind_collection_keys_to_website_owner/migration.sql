ALTER TABLE "website"
ADD COLUMN "collection_generation" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "website"
ADD CONSTRAINT "website_collection_generation_check" CHECK ("collection_generation" >= 0);

CREATE TABLE "website_collection_tombstone" (
  "website_id" UUID NOT NULL PRIMARY KEY,
  "next_generation" INTEGER NOT NULL,
  CONSTRAINT "website_collection_tombstone_generation_check" CHECK ("next_generation" > 0)
);
