#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/storage-env.sh"
test "$(uname -s)" = Darwin
test "$(fdesetup status)" = 'FileVault is On.'
test ! -e "$ANDERSON_BUILDER_SIGNING_DIR/private-key.pem"
test ! -e "$ANDERSON_BUILDER_SIGNING_DIR/public-key.pem"
mkdir -p "$ANDERSON_BUILDER_SIGNING_DIR"
chmod 0700 "$ANDERSON_BUILDER_SIGNING_DIR"
openssl genpkey -algorithm Ed25519 -out "$ANDERSON_BUILDER_SIGNING_DIR/private-key.pem"
chmod 0600 "$ANDERSON_BUILDER_SIGNING_DIR/private-key.pem"
openssl pkey -in "$ANDERSON_BUILDER_SIGNING_DIR/private-key.pem" -pubout \
  -out "$ANDERSON_BUILDER_SIGNING_DIR/public-key.pem"
chmod 0644 "$ANDERSON_BUILDER_SIGNING_DIR/public-key.pem"
printf 'Mac-only Ed25519 key created. Public-key path: %s\n' \
  "$ANDERSON_BUILDER_SIGNING_DIR/public-key.pem"
