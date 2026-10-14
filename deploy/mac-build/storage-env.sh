#!/usr/bin/env bash

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  printf 'Source this file from Bash; do not execute it.\n' >&2
  exit 2
fi

storage_root='/Volumes/Storage/General Storage'
builder_root="$storage_root/Builder"

if [[ ! -d "$storage_root" || "$(stat -f %d /Volumes/Storage)" == "$(stat -f %d /Volumes)" ]]; then
  printf 'Storage is not mounted; refusing to use the internal disk.\n' >&2
  return 1
fi

if [[ "$(realpath /Users/jacobanderson/Sites)" != "$storage_root/Sites" ]]; then
  printf 'The Sites alias no longer resolves to Storage.\n' >&2
  return 1
fi

umask 077
if ! mkdir -p "$builder_root/colima-home" "$builder_root/colima-cache" \
  "$builder_root/docker-config" "$builder_root/homebrew-cache" \
  "$builder_root/exchange" "$builder_root/tmp"; then
  printf 'Cannot prepare builder directories on Storage.\n' >&2
  return 1
fi
if ! chmod 0700 "$builder_root/tmp"; then
  printf 'Cannot secure builder directories on Storage.\n' >&2
  return 1
fi

export COLIMA_HOME="$builder_root/colima-home"
export COLIMA_CACHE_HOME="$builder_root/colima-cache"
export LIMA_HOME="$builder_root/colima-home/_lima"
export DOCKER_CONFIG="$builder_root/docker-config"
export HOMEBREW_CACHE="$builder_root/homebrew-cache"
export TMPDIR="$builder_root/tmp/"
export ANDERSON_BUILDER_EXCHANGE="$builder_root/exchange"
export ANDERSON_BUILDER_SIGNING_DIR="$HOME/Library/Application Support/AndersonArtifactBuilder"
