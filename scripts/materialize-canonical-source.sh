#!/usr/bin/env bash
set -euo pipefail
# The privileged caller supplies its independently fetched, root-private Git
# repository. Neither the source tree nor Git metadata comes from staging.
[[ $# == 3 && "$2" =~ ^[0-9a-f]{40}$ ]] || exit 2
repository="$1"
revision="$2"
destination="$3"
[[ -d "$repository" && ! -L "$repository" && -d "$destination" && ! -L "$destination" ]]
[[ -z "$(ls -A -- "$destination")" ]]
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
git -c core.hooksPath=/dev/null --git-dir="$repository" cat-file -e "$revision^{commit}"
git -c core.hooksPath=/dev/null init --quiet "$destination"
git -C "$destination" -c core.hooksPath=/dev/null -c protocol.file.allow=always \
  fetch --quiet --no-tags --no-write-fetch-head "$repository" "$revision"
git -C "$destination" -c core.hooksPath=/dev/null checkout --quiet --detach "$revision"
[[ ! -e "$destination/.git/objects/info/alternates" ]]
[[ "$(git -C "$destination" rev-parse HEAD)" == "$revision" ]]
printf '\n/.ai-work/\n/.build-cache/\n/.build-config/\n' >>"$destination/.git/info/exclude"
[[ -z "$(git -C "$destination" status --porcelain)" ]]
