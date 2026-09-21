DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "user"
    WHERE "role" = 'admin' AND "deleted_at" IS NULL
  ) THEN
    RAISE EXCEPTION 'At least one active administrator is required.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "team_user"
    GROUP BY "team_id", "user_id"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate team memberships must be resolved before this migration can run.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "team_user"
    WHERE "role" = 'team-owner'
    GROUP BY "team_id"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Teams with multiple owners must be repaired before this migration can run.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "team" t
    WHERE t."deleted_at" IS NULL
      AND (
        SELECT COUNT(*)
        FROM "team_user" tu
        JOIN "user" u ON u."user_id" = tu."user_id"
        WHERE tu."team_id" = t."team_id"
          AND tu."role" = 'team-owner'
          AND u."deleted_at" IS NULL
      ) <> 1
  ) THEN
    RAISE EXCEPTION 'Each active team must have exactly one active owner before this migration can run.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "team_user" tu
    LEFT JOIN "team" t ON t."team_id" = tu."team_id"
    LEFT JOIN "user" u ON u."user_id" = tu."user_id"
    WHERE t."team_id" IS NULL OR u."user_id" IS NULL
  ) THEN
    RAISE EXCEPTION 'Orphaned team memberships must be repaired before this migration can run.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "user"
    WHERE "role" NOT IN ('admin', 'user', 'view-only')
  ) THEN
    RAISE EXCEPTION 'Unsupported global user roles must be repaired before this migration can run.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "team_user"
    WHERE "role" NOT IN ('team-owner', 'team-manager', 'team-member', 'team-view-only')
  ) THEN
    RAISE EXCEPTION 'Unsupported team roles must be repaired before this migration can run.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "user"
    GROUP BY lower(btrim("username"))
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Usernames that differ only by case or surrounding whitespace must be resolved before this migration can run.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "session_data"
    GROUP BY "session_id", "data_key"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate session data keys must be resolved before this migration can run.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "website" WHERE ("user_id" IS NULL) = ("team_id" IS NULL)
    UNION ALL
    SELECT 1 FROM "link" WHERE ("user_id" IS NULL) = ("team_id" IS NULL)
    UNION ALL
    SELECT 1 FROM "pixel" WHERE ("user_id" IS NULL) = ("team_id" IS NULL)
    UNION ALL
    SELECT 1 FROM "board" WHERE ("user_id" IS NULL) = ("team_id" IS NULL)
  ) THEN
    RAISE EXCEPTION 'Every website, link, pixel, and board must have exactly one user or team owner before this migration can run.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "share"
    WHERE "share_type" NOT IN (1, 2, 3, 4)
  ) THEN
    RAISE EXCEPTION 'Unsupported share entity types must be repaired before this migration can run.';
  END IF;
END
$$;

CREATE UNIQUE INDEX "team_user_team_id_user_id_key"
  ON "team_user"("team_id", "user_id");

CREATE UNIQUE INDEX "team_user_one_owner_per_team_key"
  ON "team_user"("team_id")
  WHERE "role" = 'team-owner';

CREATE UNIQUE INDEX "user_username_normalized_key"
  ON "user"(lower(btrim("username")));

CREATE UNIQUE INDEX "session_data_session_id_data_key_key"
  ON "session_data"("session_id", "data_key");

ALTER TABLE "user"
  ADD CONSTRAINT "user_role_check"
  CHECK ("role" IN ('admin', 'user', 'view-only'));

ALTER TABLE "team_user"
  ADD CONSTRAINT "team_user_role_check"
  CHECK ("role" IN ('team-owner', 'team-manager', 'team-member', 'team-view-only'));

ALTER TABLE "website"
  ADD CONSTRAINT "website_owner_check"
  CHECK (("user_id" IS NULL) <> ("team_id" IS NULL));

ALTER TABLE "link"
  ADD CONSTRAINT "link_owner_check"
  CHECK (("user_id" IS NULL) <> ("team_id" IS NULL));

ALTER TABLE "pixel"
  ADD CONSTRAINT "pixel_owner_check"
  CHECK (("user_id" IS NULL) <> ("team_id" IS NULL));

ALTER TABLE "board"
  ADD CONSTRAINT "board_owner_check"
  CHECK (("user_id" IS NULL) <> ("team_id" IS NULL));

ALTER TABLE "share"
  ADD CONSTRAINT "share_type_check"
  CHECK ("share_type" IN (1, 2, 3, 4));
