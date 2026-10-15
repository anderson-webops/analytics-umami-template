#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" != 2 ]]; then
  printf 'Usage: publish.sh TAG ASSET_DIRECTORY\n' >&2
  exit 64
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "$script_dir/storage-env.sh"
source_root="$(cd "$script_dir/../.." && pwd -P)"
tag="$1"
[[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]
asset_dir="$(realpath "$2")"
public_key="$ANDERSON_BUILDER_SIGNING_DIR/public-key.pem"
test -f "$public_key"
test -z "$(git -C "$source_root" status --porcelain)"
test "$(git -C "$source_root" cat-file -t "refs/tags/$tag")" = tag
commit="$(git -C "$source_root" rev-parse "$tag^{commit}")"
test "$(git -C "$source_root" rev-parse HEAD)" = "$commit"
node "$source_root/scripts/mac-artifact-transport.mjs" verify \
  --output "$asset_dir" --public-key "$public_key"

manifest="$asset_dir/anderson-runtime-manifest.json"
repository="$(jq -r '.repository' "$manifest")"
archive="$(jq -r '.archive.name' "$manifest")"
test "$(jq -r '.tag' "$manifest")" = "$tag"
test "$(jq -r '.commit' "$manifest")" = "$commit"
test "$(git -C "$source_root" remote get-url origin)" = \
  "git@github.com:$repository.git"
gh auth status >/dev/null
find_release() {
  gh api "repos/$repository/releases?per_page=100" \
    --jq ".[] | select(.tag_name == \"$tag\")"
}
if [[ -n "$(find_release)" ]]; then
  printf 'Release already exists; refusing to replace or append assets.\n' >&2
  exit 1
fi

git -C "$source_root" push origin HEAD:refs/heads/main
git -C "$source_root" push origin "refs/tags/$tag:refs/tags/$tag"
gh release create "$tag" -R "$repository" --verify-tag --draft \
  --title "$tag" \
  --notes 'Signed Linux ARM64 runtime transport. Protected server-side review and activation remain separate.' \
  "$asset_dir/$archive" \
  "$asset_dir/anderson-runtime-manifest.json" \
  "$asset_dir/anderson-runtime-manifest.sig" \
  "$asset_dir/SHA256SUMS" \
  "$asset_dir/public-build-configuration.json" \
  "$asset_dir/acceptance-receipt.json"

release_json="$(find_release)"
test -n "$release_json"
RELEASE_JSON="$release_json" node --input-type=module - "$asset_dir" <<'NODE'
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const directory = process.argv[2];
const release = JSON.parse(process.env.RELEASE_JSON);
const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'anderson-runtime-manifest.json')));
const names = [
  manifest.archive.name,
  'anderson-runtime-manifest.json',
  'anderson-runtime-manifest.sig',
  'SHA256SUMS',
  'public-build-configuration.json',
  'acceptance-receipt.json',
].sort();
const assets = new Map(release.assets.map(asset => [asset.name, asset]));
if (!release.draft || assets.size !== names.length) {
  throw new Error('Draft release does not contain the expected exact asset set.');
}
for (const name of names) {
  const bytes = fs.readFileSync(path.join(directory, name));
  const digest = `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
  const asset = assets.get(name);
  if (!asset || asset.state !== 'uploaded' || asset.size !== bytes.length || asset.digest !== digest) {
    throw new Error(`Published asset identity differs: ${name}`);
  }
}
NODE

gh release edit "$tag" -R "$repository" --draft=false
printf 'Published immutable signed release %s at %s. Production activation is separate.\n' \
  "$tag" "$commit"
