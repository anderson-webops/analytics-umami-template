BEGIN;

INSERT INTO "user" ("user_id", "username", "password", "role")
VALUES ('11111111-1111-4111-8111-111111111111', 'synthetic-revenue-owner', repeat('x', 60), 'admin');

INSERT INTO "website" ("website_id", "name", "domain", "user_id", "collection_generation")
VALUES ('22222222-2222-4222-8222-222222222222', 'Synthetic revenue', 'example.invalid',
        '11111111-1111-4111-8111-111111111111', 0);

INSERT INTO "attested_revenue_movement"
  ("movement_id", "website_id", "source", "source_movement_id", "order_id",
   "customer_id", "kind", "amount", "currency", "collection_generation", "occurred_at")
VALUES
  ('33333333-3333-4333-8333-333333333333', '22222222-2222-4222-8222-222222222222',
   'synthetic', '44444444-4444-4444-8444-444444444444',
   '55555555-5555-4555-8555-555555555555', NULL, 'capture', 12.3400, 'USD', 0,
   '2026-10-19T00:00:00Z');

DO $$
DECLARE
  row_count integer;
BEGIN
  INSERT INTO "attested_revenue_movement"
    ("movement_id", "website_id", "source", "source_movement_id", "order_id",
     "kind", "amount", "currency", "collection_generation", "occurred_at")
  VALUES
    ('66666666-6666-4666-8666-666666666666', '22222222-2222-4222-8222-222222222222',
     'synthetic', '44444444-4444-4444-8444-444444444444',
     '55555555-5555-4555-8555-555555555555', 'capture', 12.3400, 'USD', 0,
     '2026-10-19T00:00:00Z')
  ON CONFLICT ("website_id", "source_movement_id") DO NOTHING;

  SELECT count(*) INTO row_count FROM "attested_revenue_movement";
  IF row_count <> 1 THEN
    RAISE EXCEPTION 'An identical movement retry created another row';
  END IF;

  BEGIN
    INSERT INTO "attested_revenue_movement"
      ("movement_id", "website_id", "source", "source_movement_id", "order_id",
       "kind", "amount", "currency", "collection_generation", "occurred_at")
    VALUES
      ('77777777-7777-4777-8777-777777777777', '22222222-2222-4222-8222-222222222222',
       'synthetic', '44444444-4444-4444-8444-444444444444',
       '55555555-5555-4555-8555-555555555555', 'capture', 99.0000, 'USD', 0,
       '2026-10-19T00:00:00Z');
    RAISE EXCEPTION 'A changed movement reused the business key';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO "attested_revenue_movement"
      ("movement_id", "website_id", "source", "source_movement_id", "order_id",
       "kind", "amount", "currency", "collection_generation", "occurred_at")
    VALUES
      ('77777777-7777-4777-8777-777777777777', '22222222-2222-4222-8222-222222222222',
       'alternate', '44444444-4444-4444-8444-444444444444',
       '55555555-5555-4555-8555-555555555555', 'capture', 12.3400, 'USD', 0,
       '2026-10-19T00:00:00Z');
    RAISE EXCEPTION 'A movement was duplicated under another source label';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;

  BEGIN
    UPDATE "attested_revenue_movement" SET "amount" = 99.0000;
    RAISE EXCEPTION 'A recorded movement was mutable';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO "attested_revenue_movement"
      ("movement_id", "website_id", "source", "source_movement_id", "order_id",
       "kind", "amount", "currency", "collection_generation", "occurred_at")
    VALUES
      ('88888888-8888-4888-8888-888888888888', '22222222-2222-4222-8222-222222222222',
       '../outside', '99999999-9999-4999-8999-999999999999',
       '55555555-5555-4555-8555-555555555555', 'capture', 1, 'USD', 0,
       '2026-10-19T00:00:00Z');
    RAISE EXCEPTION 'An invalid source was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO "attested_revenue_movement"
      ("movement_id", "website_id", "source", "source_movement_id", "order_id",
       "kind", "amount", "currency", "collection_generation", "occurred_at")
    VALUES
      ('88888888-8888-4888-8888-888888888888', '22222222-2222-4222-8222-222222222222',
       'synthetic', '99999999-9999-4999-8999-999999999999',
       '55555555-5555-4555-8555-555555555555', 'credit', 1, 'USD', 0,
       '2026-10-19T00:00:00Z');
    RAISE EXCEPTION 'An invalid movement kind was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO "attested_revenue_movement"
      ("movement_id", "website_id", "source", "source_movement_id", "order_id",
       "kind", "amount", "currency", "collection_generation", "occurred_at")
    VALUES
      ('88888888-8888-4888-8888-888888888888', '22222222-2222-4222-8222-222222222222',
       'synthetic', '99999999-9999-4999-8999-999999999999',
       '55555555-5555-4555-8555-555555555555', 'refund', 999999, 'USD', 0,
       '2026-10-19T00:00:00Z');
    RAISE EXCEPTION 'An unlinked refund was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO "attested_revenue_movement"
      ("movement_id", "website_id", "source", "source_movement_id", "order_id",
       "kind", "amount", "currency", "collection_generation", "occurred_at")
    VALUES
      ('88888888-8888-4888-8888-888888888888', '22222222-2222-4222-8222-222222222222',
       'synthetic', '99999999-9999-4999-8999-999999999999',
       '55555555-5555-4555-8555-555555555555', 'capture', 0, 'USD', 0,
       '2026-10-19T00:00:00Z');
    RAISE EXCEPTION 'A zero-value movement was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO "attested_revenue_movement"
      ("movement_id", "website_id", "source", "source_movement_id", "order_id",
       "kind", "amount", "currency", "collection_generation", "occurred_at")
    VALUES
      ('88888888-8888-4888-8888-888888888888', '22222222-2222-4222-8222-222222222222',
       'synthetic', '99999999-9999-4999-8999-999999999999',
       '55555555-5555-4555-8555-555555555555', 'capture', 1, 'usd', 0,
       '2026-10-19T00:00:00Z');
    RAISE EXCEPTION 'A nonstandard currency was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO "attested_revenue_movement"
      ("movement_id", "website_id", "source", "source_movement_id", "order_id",
       "kind", "amount", "currency", "collection_generation", "occurred_at")
    VALUES
      ('88888888-8888-4888-8888-888888888888', '22222222-2222-4222-8222-222222222222',
       'synthetic', '99999999-9999-4999-8999-999999999999',
       '55555555-5555-4555-8555-555555555555', 'capture', 1, 'USD', -1,
       '2026-10-19T00:00:00Z');
    RAISE EXCEPTION 'A negative collection generation was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO "attested_revenue_movement"
      ("movement_id", "website_id", "source", "source_movement_id", "order_id",
       "kind", "amount", "currency", "collection_generation", "occurred_at")
    VALUES
      ('88888888-8888-4888-8888-888888888888', '22222222-2222-4222-8222-222222222222',
       'synthetic', '99999999-9999-4999-8999-999999999999',
       '55555555-5555-4555-8555-555555555555', 'capture', 1, 'USD', 0,
       '2026-10-19T00:00:00.123456Z');
    RAISE EXCEPTION 'A sub-millisecond movement timestamp was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END $$;

INSERT INTO "website" ("website_id", "name", "domain", "user_id", "collection_generation")
VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Independent synthetic site', 'other.invalid',
        '11111111-1111-4111-8111-111111111111', 0);

INSERT INTO "attested_revenue_movement"
  ("movement_id", "website_id", "source", "source_movement_id", "order_id",
   "kind", "amount", "currency", "collection_generation", "occurred_at")
VALUES
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
   'synthetic', '44444444-4444-4444-8444-444444444444',
   '55555555-5555-4555-8555-555555555555', 'capture', 1, 'USD', 0,
   '2026-10-19T00:00:00Z');

DELETE FROM "website" WHERE "website_id" = '22222222-2222-4222-8222-222222222222';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "attested_revenue_movement"
             WHERE "website_id" = '22222222-2222-4222-8222-222222222222') THEN
    RAISE EXCEPTION 'Website deletion retained an attested movement';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "attested_revenue_movement"
                 WHERE "website_id" = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') THEN
    RAISE EXCEPTION 'Website deletion removed an independent site movement';
  END IF;
END $$;

ROLLBACK;
