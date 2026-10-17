#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -lt 4 || "$#" -gt 5 || ( "$#" = 5 && "$5" != --publish ) ]]; then
  printf 'Usage: release.sh TAG PUBLIC_CONFIG BUILDER_ID PRIVATE_KEY [--publish]\n' >&2
  exit 64
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "$script_dir/storage-env.sh"
if [[ "${ANDERSON_BUILDER_LOCK_HELD:-}" != 1 ]]; then
  mkdir -p "$ANDERSON_BUILDER_EXCHANGE/locks"
  chmod 0700 "$ANDERSON_BUILDER_EXCHANGE/locks"
  exec /usr/bin/lockf -t 0 "$ANDERSON_BUILDER_EXCHANGE/locks/release.lock" \
    /usr/bin/env ANDERSON_BUILDER_LOCK_HELD=1 /bin/bash "$script_dir/release.sh" "$@"
fi
source_root="$(cd "$script_dir/../.." && pwd -P)"
tag="$1"
config="$(realpath "$2")"
builder_id="$3"
key_path="$(realpath "$4")"
publish="${5:-}"
test "$(uname -s)" = Darwin
test "$(uname -m)" = arm64
test -f "$key_path"

identity="$(node "$script_dir/public-environment.mjs" "$config" identity)"
site="${identity%%$'\n'*}"
repository="${identity##*$'\n'}"
[[ "$site" =~ ^[a-z0-9][a-z0-9.-]+$ ]]
[[ "$repository" =~ ^anderson-webops/[a-z0-9][a-z0-9.-]+$ ]]
[[ "$builder_id" =~ ^[a-z0-9-]{1,64}$ ]]
[[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]
test "$(git -C "$source_root" remote get-url origin)" = \
  "git@github.com:$repository.git"
test -z "$(git -C "$source_root" status --porcelain)"
test "$(git -C "$source_root" cat-file -t "refs/tags/$tag")" = tag
commit="$(git -C "$source_root" rev-parse HEAD)"
test "$(git -C "$source_root" rev-parse "$tag^{commit}")" = "$commit"
test "$(node -p "require('$source_root/package.json').version")" = "${tag#v}"

colima status >/dev/null
test "$(docker --context colima info --format '{{.OSType}}/{{.Architecture}}')" = linux/aarch64
docker --context colima buildx version >/dev/null
run_name="${site}-${tag}-$(date -u +%Y%m%dT%H%M%SZ)-${commit:0:8}"
run_root="$ANDERSON_BUILDER_EXCHANGE/mac-build-runs/$run_name"
mkdir -p "$ANDERSON_BUILDER_EXCHANGE/mac-build-runs"
chmod 0700 "$ANDERSON_BUILDER_EXCHANGE/mac-build-runs"
mkdir -m 0700 "$run_root"
cp "$config" "$run_root/public-config.json"
git -C "$source_root" bundle create "$run_root/source.bundle" HEAD "refs/tags/$tag"
git -C "$source_root" bundle verify "$run_root/source.bundle" >/dev/null

image="anderson-analytics-builder:${commit:0:12}"
node "$script_dir/run-bounded.mjs" "$run_root/image-build.log" 1800 8388608 \
  docker --context colima buildx build --load --platform linux/arm64 --pull=false \
    --tag "$image" --file "$script_dir/Dockerfile" "$script_dir"
test "$(docker --context colima image inspect "$image" --format '{{.Os}}/{{.Architecture}}')" = \
  linux/arm64

toolchain_fingerprint="$(
  docker --context colima image inspect "$image" |
    node "$script_dir/toolchain-fingerprint.mjs"
)"
cache_volumes="$(
  node "$script_dir/cache-key.mjs" "$source_root" "$run_root/public-config.json" "$repository" "$toolchain_fingerprint"
)"
read -r store_volume compiler_volume <<< "$cache_volumes"
[[ "$store_volume" =~ ^anderson-pnpm-[0-9a-f]{64}$ ]]
[[ "$compiler_volume" =~ ^anderson-next-[0-9a-f]{64}$ ]]
printf 'Storage cache scopes: pnpm=%s compiler=%s\n' "$store_volume" "$compiler_volume"
docker --context colima volume create \
  --label anderson.cache-kind=pnpm \
  --label "anderson.repository=$repository" "$store_volume" >/dev/null
test "$(docker --context colima volume inspect --format '{{ index .Labels "anderson.cache-kind" }}' "$store_volume")" = pnpm
test "$(docker --context colima volume inspect --format '{{ index .Labels "anderson.repository" }}' "$store_volume")" = "$repository"
docker --context colima run --rm --network none --user 0:0 \
  --mount "type=volume,src=$store_volume,dst=/pnpm-store" "$image" \
  sh -c 'chown 501:20 /pnpm-store && chmod 0700 /pnpm-store'
docker --context colima volume create \
  --label anderson.cache-kind=compiler \
  --label "anderson.repository=$repository" "$compiler_volume" >/dev/null
test "$(docker --context colima volume inspect --format '{{ index .Labels "anderson.cache-kind" }}' "$compiler_volume")" = compiler
test "$(docker --context colima volume inspect --format '{{ index .Labels "anderson.repository" }}' "$compiler_volume")" = "$repository"
docker --context colima run --rm --network none --user 0:0 \
  --mount "type=volume,src=$compiler_volume,dst=/compiler-cache" "$image" \
  sh -c 'chown 501:20 /compiler-cache && chmod 0700 /compiler-cache'

volume="anderson-mac-build-${commit:0:12}-$$"
docker --context colima volume create "$volume" >/dev/null
active_container=""
copy_container=""
remove_volume() {
  if [[ -n "$active_container" ]]; then
    docker --context colima container rm -f "$active_container" >/dev/null 2>&1 || true
  fi
  if [[ -n "$copy_container" ]]; then
    docker --context colima container rm -fv "$copy_container" >/dev/null 2>&1 || true
  fi
  docker --context colima volume rm "$volume" >/dev/null || true
}
trap remove_volume EXIT
docker --context colima run --rm --network none --user 0:0 \
  --mount "type=volume,src=$volume,dst=/work" "$image" \
  sh -c 'chown 501:20 /work && chmod 0755 /work'

common=(
  --mount "type=volume,src=$volume,dst=/work"
  --cpus 4 --memory 7g --memory-swap 7g --pids-limit 1024
  --env "RELEASE_TAG=$tag"
  --env "RELEASE_COMMIT=$commit"
  --env "RELEASE_REPOSITORY=$repository"
  --env "RELEASE_BUILDER_ID=$builder_id"
  --env RELEASE_CONFIG=/work/public-config.json
  --env RELEASE_OUTPUT=/work/assets
  --env HOME=/work/home
)

run_phase() {
  local phase="$1" seconds="$2"
  shift 2
  active_container="$volume-$phase"
  node "$script_dir/run-bounded.mjs" "$run_root/$phase.log" "$seconds" 8388608 \
    docker --context colima run --rm --name "$active_container" --init \
      --log-driver local --log-opt max-size=8m --log-opt max-file=1 \
      --log-opt compress=false \
      "$@"
  active_container=""
}

run_phase checkout 600 --user 501:20 --network none \
  --mount "type=bind,src=$run_root,dst=/release-data,readonly" \
  "${common[@]}" "$image" bash -lc '
    set -euo pipefail
    mkdir -p /work/home /work/tmp
    cp /release-data/public-config.json "$RELEASE_CONFIG"
    chmod 0600 "$RELEASE_CONFIG"
    git clone --quiet --no-checkout /release-data/source.bundle /work/source
    printf "/.ai-work/\n" >> "$(git -C /work/source rev-parse --path-format=absolute --git-path info/exclude)"
    git -C /work/source checkout --quiet --detach "$RELEASE_TAG^{commit}"
    mkdir -p /work/source/.next/cache
  '

run_phase build 7200 --user 501:20 --network bridge \
  --mount "type=volume,src=$store_volume,dst=/pnpm-store" \
  --mount "type=volume,src=$compiler_volume,dst=/work/source/.next/cache" \
  "${common[@]}" "$image" bash -lc '
    set -euo pipefail
    node /work/source/deploy/mac-build/public-environment.mjs "$RELEASE_CONFIG" run \
      bash /work/source/deploy/mac-build/container-phase.sh build
  '

run_phase accept 3600 --user 0:0 --network none --privileged \
  "${common[@]}" "$image" bash -lc '
    set -euo pipefail
    node /work/source/deploy/mac-build/public-environment.mjs "$RELEASE_CONFIG" run \
      bash /work/source/deploy/mac-build/container-phase.sh accept
  '

run_phase inventory 60 --user 0:0 --network none --read-only --cap-drop ALL \
  --mount "type=volume,src=$volume,dst=/work,readonly" \
  --cpus 1 --memory 256m --pids-limit 64 \
  --env "RELEASE_SITE=$site" --env "RELEASE_TAG=$tag" \
  "$image" node /work/source/deploy/mac-build/verify-unsigned-assets.mjs \
    /work/assets "$site" "$tag"

test ! -e "$run_root/assets"
copy_container="$volume-copy"
docker --context colima create --name "$copy_container" --network none --read-only \
  --mount "type=volume,src=$volume,dst=/work,readonly" "$image" true >/dev/null
node "$script_dir/run-bounded.mjs" "$run_root/collect.log" 600 8388608 \
  docker --context colima cp "$copy_container:/work/assets" "$run_root/assets"
docker --context colima container rm -v "$copy_container" >/dev/null
copy_container=""
node "$script_dir/verify-unsigned-assets.mjs" "$run_root/assets" "$site" "$tag" \
  "$repository" "$run_root/public-config.json"

node "$source_root/scripts/mac-artifact-transport.mjs" sign \
  --output "$run_root/assets" --key "$key_path"
node "$source_root/scripts/mac-artifact-transport.mjs" verify \
  --output "$run_root/assets" \
  --public-key "$ANDERSON_BUILDER_SIGNING_DIR/public-key.pem"
node --input-type=module -e '
  import fs from "node:fs";
  const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const expandedBytes = manifest.files
    .filter(file => file.type === "file")
    .reduce((total, file) => total + file.size, 0);
  process.stdout.write(
    `Verified release bytes: archive=${manifest.archive.size} expanded=${expandedBytes}\n`,
  );
' "$run_root/assets/anderson-runtime-manifest.json"
printf 'Signed Linux ARM64 release assets: %s\n' "$run_root/assets"
if [[ "$publish" = --publish ]]; then
  bash "$script_dir/publish.sh" "$tag" "$run_root/assets"
fi
