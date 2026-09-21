BEGIN;

WITH ranked_session_data AS (
  SELECT
    "session_data_id",
    ROW_NUMBER() OVER (
      PARTITION BY "session_id", "data_key"
      ORDER BY "created_at" DESC NULLS LAST, "session_data_id" DESC
    ) AS row_num
  FROM "session_data"
)
DELETE FROM "session_data"
USING ranked_session_data
WHERE "session_data"."session_data_id" = ranked_session_data."session_data_id"
  AND ranked_session_data.row_num > 1;

CREATE UNIQUE INDEX IF NOT EXISTS "session_data_session_id_data_key_key"
ON "session_data"("session_id", "data_key");

DO $$
DECLARE
  canonical_index CONSTANT text := 'session_data_session_id_data_key_key';
  legacy_index CONSTANT text := 'session_data_session_id_data_key_key_pre_v4_2_4';
  session_data_table oid := to_regclass(format('%I.%I', current_schema(), 'session_data'));
  canonical_oid oid := to_regclass(format('%I.%I', current_schema(), canonical_index));
  legacy_oid oid := to_regclass(format('%I.%I', current_schema(), legacy_index));
BEGIN
  IF canonical_oid IS NULL OR NOT EXISTS (
    SELECT 1
    FROM pg_index
    WHERE indexrelid = canonical_oid
      AND indrelid = session_data_table
      AND indisunique
      AND indisvalid
      AND indisready
      AND indnkeyatts = 2
      AND indnatts = 2
      AND indexprs IS NULL
      AND indpred IS NULL
      AND pg_get_indexdef(indexrelid, 1, true) = 'session_id'
      AND pg_get_indexdef(indexrelid, 2, true) = 'data_key'
  ) THEN
    RAISE EXCEPTION 'The canonical session-data unique index was not rebuilt safely.';
  END IF;

  IF legacy_oid IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_index
      WHERE indexrelid = legacy_oid
        AND indrelid = session_data_table
        AND indisunique
        AND indisvalid
        AND indisready
        AND indnkeyatts = 2
        AND indnatts = 2
        AND indexprs IS NULL
        AND indpred IS NULL
        AND pg_get_indexdef(indexrelid, 1, true) = 'session_id'
        AND pg_get_indexdef(indexrelid, 2, true) = 'data_key'
    ) THEN
      RAISE EXCEPTION 'The retained session-data index is not safe to remove.';
    END IF;

    EXECUTE format('DROP INDEX %I.%I', current_schema(), legacy_index);
  END IF;
END
$$;

COMMIT;
