CREATE TABLE "login_recovery_credential" (
    "id" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "code_digest" CHAR(64) NOT NULL,
    "password_fingerprint" CHAR(128) NOT NULL,
    "key_fingerprint" CHAR(64) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "login_recovery_credential_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "login_recovery_credential_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "login_recovery_credential_code_digest_key"
ON "login_recovery_credential"("code_digest");

CREATE INDEX "login_recovery_credential_user_id_password_fingerprint_key_fingerprint_consumed_at_idx"
ON "login_recovery_credential"("user_id", "password_fingerprint", "key_fingerprint", "consumed_at");
