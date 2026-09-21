DO $$
DECLARE
  redundant_index CONSTANT text := 'board_board_id_key';
  board_table oid := to_regclass(format('%I.%I', current_schema(), 'board'));
  redundant_oid oid := to_regclass(format('%I.%I', current_schema(), redundant_index));
BEGIN
  IF board_table IS NULL THEN
    RAISE EXCEPTION 'The board table must exist before removing its redundant index.';
  END IF;

  IF redundant_oid IS NULL THEN
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_index
    WHERE indexrelid = redundant_oid
      AND indrelid = board_table
      AND indisunique
      AND indisvalid
      AND indisready
      AND indnkeyatts = 1
      AND indnatts = 1
      AND indexprs IS NULL
      AND indpred IS NULL
      AND pg_get_indexdef(indexrelid, 1, true) = 'board_id'
  ) THEN
    RAISE EXCEPTION 'The board_board_id_key index does not match the reviewed redundant index.';
  END IF;

  EXECUTE format('DROP INDEX %I.%I', current_schema(), redundant_index);
END
$$;
