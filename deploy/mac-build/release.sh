#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -lt 4 || "$#" -gt 5 || ( "$#" = 5 && "$5" != --publish ) ]]; then
  printf 'Usage: release.sh TAG PUBLIC_CONFIG BUILDER_ID PRIVATE_KEY [--publish]\n' >&2
  exit 64
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "$script_dir/storage-env.sh"
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
run_name="${site}-${tag}-$(date -u +%Y%m%dT%H%M%SZ)-${commit:0:8}"
run_root="$ANDERSON_BUILDER_EXCHANGE/mac-build-runs/$run_name"
mkdir -p "$ANDERSON_BUILDER_EXCHANGE/mac-build-runs"
chmod 0700 "$ANDERSON_BUILDER_EXCHANGE/mac-build-runs"
mkdir -m 0700 "$run_root"
cp "$config" "$run_root/public-config.json"
git -C "$source_root" bundle create "$run_root/source.bundle" HEAD "refs/tags/$tag"
git -C "$source_root" bundle verify "$run_root/source.bundle" >/dev/null

image="anderson-analytics-builder:${commit:0:12}"
docker --context colima build --platform linux/arm64 --pull=false \
  --tag "$image" --file "$script_dir/Dockerfile" "$script_dir"
test "$(docker --context colima image inspect "$image" --format '{{.Os}}/{{.Architecture}}')" = \
  linux/arm64

volume="anderson-mac-build-${commit:0:12}-$$"
docker --context colima volume create "$volume" >/dev/null
remove_volume() {
  docker --context colima volume rm "$volume" >/dev/null || true
}
trap remove_volume EXIT
docker --context colima run --rm --network none --user 0:0 \
  --mount "type=volume,src=$volume,dst=/work" "$image" \
  sh -c 'chown 501:20 /work && chmod 0755 /work'

common=(
  --mount "type=volume,src=$volume,dst=/work"
  --mount "type=bind,src=$ANDERSON_BUILDER_EXCHANGE,dst=/exchange"
  --cpus 4 --memory 5g
  --env "RELEASE_TAG=$tag"
  --env "RELEASE_COMMIT=$commit"
  --env "RELEASE_REPOSITORY=$repository"
  --env "RELEASE_BUILDER_ID=$builder_id"
  --env "RELEASE_CONFIG=/exchange/mac-build-runs/$run_name/public-config.json"
  --env "RELEASE_OUTPUT=/exchange/mac-build-runs/$run_name/assets"
  --env HOME=/work/home
)

docker --context colima run --rm --user 501:20 --network bridge \
  "${common[@]}" "$image" bash -lc '
    set -euo pipefail
    mkdir -p /work/home /work/tmp
    git clone --quiet --no-checkout "${RELEASE_CONFIG%/*}/source.bundle" /work/source
    git -C /work/source checkout --quiet --detach "$RELEASE_TAG^{commit}"
    node /work/source/deploy/mac-build/public-environment.mjs "$RELEASE_CONFIG" run \
      bash /work/source/deploy/mac-build/container-phase.sh build
  ' 2>&1 | tee "$run_root/build.log"

docker --context colima run --rm --user 0:0 --network none --privileged \
  "${common[@]}" "$image" bash -lc '
    set -euo pipefail
    node /work/source/deploy/mac-build/public-environment.mjs "$RELEASE_CONFIG" run \
      bash /work/source/deploy/mac-build/container-phase.sh accept
  ' 2>&1 | tee "$run_root/acceptance.log"

node "$source_root/scripts/mac-artifact-transport.mjs" sign \
  --output "$run_root/assets" --key "$key_path"
node "$source_root/scripts/mac-artifact-transport.mjs" verify \
  --output "$run_root/assets" \
  --public-key "$ANDERSON_BUILDER_SIGNING_DIR/public-key.pem"
printf 'Signed Linux ARM64 release assets: %s\n' "$run_root/assets"
if [[ "$publish" = --publish ]]; then
  bash "$script_dir/publish.sh" "$tag" "$run_root/assets"
fi
