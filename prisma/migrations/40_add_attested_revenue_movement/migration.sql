CREATE TABLE "attested_revenue_movement" (
  "movement_id" UUID NOT NULL PRIMARY KEY,
  "website_id" UUID NOT NULL,
  "source" VARCHAR(40) NOT NULL,
  "source_movement_id" UUID NOT NULL,
  "order_id" UUID NOT NULL,
  "customer_id" UUID,
  "kind" VARCHAR(7) NOT NULL,
  "amount" DECIMAL(19,4) NOT NULL,
  "currency" CHAR(3) NOT NULL,
  "collection_generation" INTEGER NOT NULL,
  "occurred_at" TIMESTAMPTZ(6) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "attested_revenue_movement_source_check" CHECK (("source" COLLATE "C") ~ '^[a-z][a-z0-9_-]{0,39}$'),
  CONSTRAINT "attested_revenue_movement_kind_check" CHECK ("kind" = 'capture'),
  CONSTRAINT "attested_revenue_movement_amount_check" CHECK ("amount" > 0),
  CONSTRAINT "attested_revenue_movement_currency_check" CHECK (("currency" COLLATE "C") ~ '^[A-Z]{3}$'),
  CONSTRAINT "attested_revenue_movement_generation_check" CHECK ("collection_generation" >= 0),
  CONSTRAINT "attested_revenue_movement_precision_check" CHECK ("occurred_at" = date_trunc('milliseconds', "occurred_at")),
  CONSTRAINT "attested_revenue_movement_website_fkey" FOREIGN KEY ("website_id") REFERENCES "website"("website_id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "attested_revenue_movement_idempotency_key"
  ON "attested_revenue_movement"("website_id", "source_movement_id");

CREATE INDEX "attested_revenue_movement_report_idx"
  ON "attested_revenue_movement"("website_id", "currency", "occurred_at");

CREATE FUNCTION reject_attested_revenue_movement_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Attested revenue movements are immutable' USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER attested_revenue_movement_immutable
BEFORE UPDATE ON "attested_revenue_movement"
FOR EACH ROW EXECUTE FUNCTION reject_attested_revenue_movement_update();
