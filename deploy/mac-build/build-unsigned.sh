#!/usr/bin/env bash
set -euo pipefail

installed_root="$HOME/Library/Application Support/AndersonArtifactBuilder/analytics-builder-v1"
script_path="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/$(basename "${BASH_SOURCE[0]}")"
if [[ "$script_path" != "$installed_root/build-unsigned.sh" || "$(uname -sm)" != 'Darwin arm64' ]]; then
  printf 'Use the reviewed installed Mac unsigned builder.\n' >&2
  exit 78
fi
node_bin=/opt/homebrew/opt/node@24/bin/node
test "$("$node_bin" --version)" = v24.22.1
export PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin
"$node_bin" --input-type=module - "$installed_root" <<'NODE'
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
const root = process.argv[2];
const inventoryPath = path.join(root, 'installation.json');
const inventoryMetadata = fs.lstatSync(inventoryPath);
if (!inventoryMetadata.isFile() || inventoryMetadata.isSymbolicLink() || inventoryMetadata.nlink !== 1 || inventoryMetadata.uid !== process.getuid() || (inventoryMetadata.mode & 0o777) !== 0o600 || inventoryMetadata.size > 8192) throw Error('Unprotected unsigned builder inventory.');
const expected = JSON.parse(fs.readFileSync(inventoryPath));
const requiredFiles = ['build-unsigned.sh', 'deploy/mac-build/storage-env.sh', 'deploy/mac-build/public-environment.mjs', 'deploy/mac-build/run-bounded.mjs', 'deploy/mac-build/verify-unsigned-assets.mjs', 'scripts/mac-artifact-transport.mjs', 'scripts/runtime-artifact.mjs'].sort();
if (expected.schemaVersion !== 1 || !expected.files || JSON.stringify(Object.keys(expected.files).sort()) !== JSON.stringify(requiredFiles) || !expected.toolchain || !/^[a-f0-9]{64}$/.test(expected.toolchain.sha256) || !path.isAbsolute(expected.toolchain.archive)) throw Error('Invalid unsigned builder installation.');
for (const directory of [path.dirname(root), root]) {
  const metadata = fs.lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.getuid() || (metadata.mode & 0o777) !== 0o700 || fs.realpathSync(directory) !== directory) throw Error('Unprotected unsigned builder installation.');
}
for (const [name, digest] of Object.entries(expected.files)) {
  if (!/^[a-z0-9.-]+(?:\/[a-z0-9.-]+)*$/.test(name) || name.split('/').some(part => part === '.' || part === '..') || !/^[a-f0-9]{64}$/.test(digest)) throw Error('Invalid installed file identity.');
  const filename = path.join(root, name);
  const metadata = fs.lstatSync(filename);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.uid !== process.getuid() || (metadata.mode & 0o777) !== 0o600 || fs.realpathSync(filename) !== filename || crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex') !== digest) throw Error('Unsigned builder installation changed.');
}
for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'GH_TOKEN', 'GITHUB_TOKEN', 'SSH_AUTH_SOCK', 'BASH_ENV', 'ENV', 'DOCKER_HOST', 'DOCKER_CONTEXT']) {
  if (process.env[name]) throw Error('Use a fresh credential-free unsigned builder environment.');
}
NODE

if [[ "${1:-}" = check && "$#" = 1 ]]; then
  printf 'Installed unsigned builder inventory verified; signing and publication are separate.\n'
  exit 0
fi
if [[ "$#" != 5 || "$1" != build ]]; then
  printf 'Usage: build-unsigned.sh build SOURCE TAG PUBLIC_CONFIG OUTPUT\n' >&2
  exit 64
fi
source_root="$(cd "$2" && pwd -P)"
tag="$3"
configuration="$(realpath "$4")"
output_parent="$(cd "$(dirname "$5")" && pwd -P)"
output="$output_parent/$(basename "$5")"
test ! -e "$output"
[[ "$tag" =~ ^v4\.[0-9]+\.[0-9]+$ ]]
source "$installed_root/deploy/mac-build/storage-env.sh"
if [[ "${ANDERSON_UNSIGNED_LOCK_HELD:-}" != 1 ]]; then
  mkdir -p "$ANDERSON_BUILDER_EXCHANGE/locks"
  exec /usr/bin/lockf -t 0 "$ANDERSON_BUILDER_EXCHANGE/locks/release.lock" \
    /usr/bin/env ANDERSON_UNSIGNED_LOCK_HELD=1 /bin/bash "$script_path" "$@"
fi
identity="$("$node_bin" "$installed_root/deploy/mac-build/public-environment.mjs" "$configuration" identity)"
site="${identity%%$'\n'*}"
repository="${identity##*$'\n'}"
case "$site:$repository" in
  analytics.example.com:anderson-webops/analytics-umami-template | \
  analytics.np-servicerequest.org:anderson-webops/analytics.np-servicerequest.org | \
  analytics.mariettaviolinwithcarla.com:anderson-webops/analytics.mariettaviolinwithcarla.com | \
  analytics.retrozetrocomics.com:anderson-webops/analytics.retrozetrocomics.com | \
  analytics.jacobdanderson.net:anderson-webops/analytics.jacobdanderson.net) ;;
  *) printf 'Application is outside this reviewed builder scope.\n' >&2; exit 78 ;;
esac
test "$(git -C "$source_root" remote get-url origin)" = "git@github.com:$repository.git"
test -z "$(git -C "$source_root" status --porcelain)"
test "$(git -C "$source_root" cat-file -t "refs/tags/$tag")" = tag
commit="$(git -C "$source_root" rev-parse HEAD)"
tree="$(git -C "$source_root" rev-parse 'HEAD^{tree}')"
test "$(git -C "$source_root" rev-parse "$tag^{commit}")" = "$commit"
test "$(git -C "$source_root" rev-parse refs/remotes/origin/main)" = "$commit"
test "$("$node_bin" -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1])).version' "$source_root/package.json")" = "${tag#v}"
test "$(df -Pk "$ANDERSON_BUILDER_EXCHANGE" | tail -1 | awk '{print $4}')" -ge 16777216
test -z "$(docker --context colima ps --format '{{.ID}}')"
colima --profile default status >/dev/null
profile="ar$(date -u +%H%M%S)"
context="colima-$profile"
socket_path="$LIMA_HOME/colima-$profile/ssh.sock.1234567890123456"
test "${#socket_path}" -lt 104
test ! -d "$COLIMA_HOME/$profile"
test ! -d "$LIMA_HOME/colima-$profile"
mkdir -m 0700 "$output"
git -C "$source_root" bundle create "$output/source.bundle" HEAD "refs/tags/$tag"
git -C "$source_root" bundle verify "$output/source.bundle" >/dev/null
cp "$configuration" "$output/public-config.json"
toolchain_archive="$("$node_bin" -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1])).toolchain.archive' "$installed_root/installation.json")"
toolchain_sha256="$("$node_bin" -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1])).toolchain.sha256' "$installed_root/installation.json")"
test "$(shasum -a 256 "$toolchain_archive" | awk '{print $1}')" = "$toolchain_sha256"
profile_created=false
default_stopped=false
write_state() {
  "$node_bin" --input-type=module - "$output/builder-state.json" "$profile" "$commit" "$tree" "$1" "$2" <<'NODE'
import fs from 'node:fs';
const [destination, profile, commit, tree, status, result] = process.argv.slice(2);
fs.writeFileSync(destination, `${JSON.stringify({schemaVersion:1,profile,commit,tree,status,exitCode:Number(result),freshVmDestroyed:status==='finished',hostMounts:'none',sshAgentForwarded:false,privateKeyRead:false,publicationAttempted:false,productionActivated:false})}\n`, {mode:0o600});
NODE
}
cleanup() {
  local result=$?
  trap - EXIT INT TERM HUP
  if [[ "$profile_created" = true ]]; then
    if ! colima --profile "$profile" delete --force --data; then result=1; fi
    if [[ -d "$COLIMA_HOME/$profile" || -d "$LIMA_HOME/colima-$profile" ]]; then result=1; fi
  fi
  if [[ "$default_stopped" = true ]]; then
    if ! colima --profile default start --save-config=false --activate=false --ssh-config=false; then result=1; fi
  fi
  if [[ "$result" = 0 ]]; then write_state finished 0; else write_state failed "$result"; fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP
write_state preparing 0
default_stopped=true
colima --profile default stop
profile_created=true
colima --profile "$profile" start --activate=false --ssh-config=false --ssh-agent=false \
  --template=false --mount none --vz-rosetta=false --port-forwarder none \
  --arch aarch64 --vm-type vz --runtime docker --cpus 4 --memory 8 --disk 48
colima --profile "$profile" ssh -- sh -c \
  'if findmnt -rn -t virtiofs,9p,fuse.sshfs -o TARGET; then exit 1; fi; test -z "${SSH_AUTH_SOCK:-}"'
test "$(docker --context "$context" info --format '{{.OSType}}/{{.Architecture}}')" = linux/aarch64
gzip -dc "$toolchain_archive" | docker --context "$context" load
base_image=anderson-analytics-builder:node24.18.1-npm12.0.2-pnpm11.18.0
image=anderson-disposable-release:fixed-toolchain
printf 'FROM %s\nRUN getent passwd 501 >/dev/null || useradd --uid 501 --gid 20 --no-create-home --shell /bin/bash artifact-builder\n' "$base_image" |
  docker --context "$context" build --network none --tag "$image" -
volume="$profile-work"
store="$profile-pnpm"
docker --context "$context" volume create "$volume" >/dev/null
docker --context "$context" volume create "$store" >/dev/null
docker --context "$context" run --rm --network none --user 0:0 --cap-drop ALL --cap-add CHOWN \
  --mount "type=volume,src=$volume,dst=/work,volume-nocopy" \
  --mount "type=volume,src=$store,dst=/pnpm-store,volume-nocopy" \
  --entrypoint /bin/sh "$image" -c 'set -e; chmod 0755 /work /pnpm-store; chown 501:20 /work /pnpm-store'
common=(--mount "type=volume,src=$volume,dst=/work,volume-nocopy"
  --cpus 4 --memory 7g --memory-swap 7g --pids-limit 1024
  --env "RELEASE_TAG=$tag" --env "RELEASE_COMMIT=$commit"
  --env "RELEASE_REPOSITORY=$repository" --env RELEASE_BUILDER_ID=jacob-m3
  --env RELEASE_CONFIG=/work/public-config.json --env RELEASE_OUTPUT=/work/assets
  --env HOME=/work/home --env CI=1)
COPYFILE_DISABLE=1 tar --no-xattrs --no-acls --no-fflags -cf - -C "$output" source.bundle public-config.json |
  docker --context "$context" run --rm -i --network none --user 501:20 --cap-drop ALL \
    --security-opt no-new-privileges "${common[@]}" --entrypoint /bin/bash "$image" -c '
      set -euo pipefail
      umask 077
      mkdir /work/input /work/home /work/tmp
      tar -xf - -C /work/input --no-same-owner
      cp /work/input/public-config.json /work/public-config.json
      git clone --quiet --no-checkout /work/input/source.bundle /work/source
      git -C /work/source checkout --quiet --detach "$RELEASE_TAG^{commit}"
      printf "/.ai-work/\n" >> "$(git -C /work/source rev-parse --path-format=absolute --git-path info/exclude)"
    '
write_state building 0
"$node_bin" "$installed_root/deploy/mac-build/run-bounded.mjs" "$output/build.log" 10800 16777216 \
  docker --context "$context" run --rm --init --network bridge --user 501:20 --cap-drop ALL \
    --security-opt no-new-privileges --log-driver local --log-opt max-size=8m --log-opt max-file=1 \
    --mount "type=volume,src=$store,dst=/pnpm-store,volume-nocopy" \
    "${common[@]}" --entrypoint /bin/bash "$image" -c '
      set -euo pipefail
      node /work/source/deploy/mac-build/public-environment.mjs "$RELEASE_CONFIG" run \
        bash /work/source/deploy/mac-build/container-phase.sh build
    '
colima --profile "$profile" ssh -- sh -c \
  'if findmnt -rn -t virtiofs,9p,fuse.sshfs -o TARGET; then exit 1; fi; test -z "${SSH_AUTH_SOCK:-}"'
write_state accepting 0
"$node_bin" "$installed_root/deploy/mac-build/run-bounded.mjs" "$output/accept.log" 5400 16777216 \
  docker --context "$context" run --rm --init --network none --user 0:0 --privileged \
    --log-driver local --log-opt max-size=8m --log-opt max-file=1 \
    "${common[@]}" --entrypoint /bin/bash "$image" -c '
      set -euo pipefail
      node /work/source/deploy/mac-build/public-environment.mjs "$RELEASE_CONFIG" run \
        bash /work/source/deploy/mac-build/container-phase.sh accept
    '
copy_container="$profile-export"
docker --context "$context" create --name "$copy_container" --network none --read-only \
  --mount "type=volume,src=$volume,dst=/work,readonly,volume-nocopy" \
  --entrypoint /bin/true "$image" >/dev/null
"$node_bin" "$installed_root/deploy/mac-build/run-bounded.mjs" "$output/collect.log" 600 8388608 \
  docker --context "$context" cp "$copy_container:/work/assets" "$output/assets"
docker --context "$context" container rm -v "$copy_container" >/dev/null
"$node_bin" "$installed_root/deploy/mac-build/verify-unsigned-assets.mjs" "$output/assets" "$site" "$tag" \
  "$repository" "$output/public-config.json"
printf 'Unsigned exact-tag assets: %s/assets\nSigning remains a separate independently approved operation.\n' "$output"
