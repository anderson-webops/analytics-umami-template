DO $$
DECLARE
  canonical_index CONSTANT text := 'session_data_session_id_data_key_key';
  legacy_index CONSTANT text := 'session_data_session_id_data_key_key_pre_v4_2_4';
  session_data_table oid := to_regclass(format('%I.%I', current_schema(), 'session_data'));
  canonical_oid oid := to_regclass(format('%I.%I', current_schema(), canonical_index));
  legacy_oid oid := to_regclass(format('%I.%I', current_schema(), legacy_index));
BEGIN
  IF session_data_table IS NULL THEN
    RAISE EXCEPTION 'The session_data table must exist before preparing its unique index.';
  END IF;

  IF canonical_oid IS NOT NULL AND NOT EXISTS (
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
    RAISE EXCEPTION 'The existing session-data index does not match the reviewed unique index.';
  END IF;

  IF legacy_oid IS NOT NULL AND NOT EXISTS (
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
    RAISE EXCEPTION 'The retained session-data index does not match the reviewed unique index.';
  END IF;

  IF canonical_oid IS NOT NULL AND legacy_oid IS NULL THEN
    EXECUTE format(
      'ALTER INDEX %I.%I RENAME TO %I',
      current_schema(),
      canonical_index,
      legacy_index
    );
  ELSIF canonical_oid IS NOT NULL AND legacy_oid IS NOT NULL THEN
    EXECUTE format('DROP INDEX %I.%I', current_schema(), canonical_index);
  END IF;
END
$$;
