#!/usr/bin/env bash
set -euo pipefail

original_args=("$@")
apply=false
selected_volume=''
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --apply)
      apply=true
      shift
      ;;
    --volume)
      if [[ -z "${2:-}" ]]; then
        printf 'Expected a cache volume after --volume.\n' >&2
        exit 64
      fi
      selected_volume="${2:-}"
      shift 2
      ;;
    *)
      printf 'Usage: cache-maintenance.sh [--volume CACHE_VOLUME] [--apply]\n' >&2
      exit 64
      ;;
  esac
done
if [[ -n "$selected_volume" && ! "$selected_volume" =~ ^anderson-(pnpm|next)-[0-9a-f]{64}$ ]]; then
  printf 'Invalid cache volume selection.\n' >&2
  exit 64
fi
if [[ "$apply" = true && -z "$selected_volume" ]]; then
  printf 'Select one reviewed cache volume before applying removal.\n' >&2
  exit 64
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "$script_dir/storage-env.sh"
if [[ "${ANDERSON_BUILDER_LOCK_HELD:-}" != 1 ]]; then
  mkdir -p "$ANDERSON_BUILDER_EXCHANGE/locks"
  chmod 0700 "$ANDERSON_BUILDER_EXCHANGE/locks"
  if ((${#original_args[@]})); then
    exec /usr/bin/lockf -t 0 "$ANDERSON_BUILDER_EXCHANGE/locks/release.lock" \
      /usr/bin/env ANDERSON_BUILDER_LOCK_HELD=1 /bin/bash "$script_dir/cache-maintenance.sh" \
      "${original_args[@]}"
  fi
  exec /usr/bin/lockf -t 0 "$ANDERSON_BUILDER_EXCHANGE/locks/release.lock" \
    /usr/bin/env ANDERSON_BUILDER_LOCK_HELD=1 /bin/bash "$script_dir/cache-maintenance.sh"
fi
colima status >/dev/null
test "$(docker --context colima info --format '{{.OSType}}/{{.Architecture}}')" = linux/aarch64
image="$(
  docker --context colima image ls \
    --filter 'reference=anderson-analytics-builder:*' \
    --format '{{.Repository}}:{{.Tag}}' | sed -n '1p'
)"
if [[ -z "$image" ]]; then
  printf 'No reviewed analytics builder image is available for cache measurement.\n' >&2
  exit 1
fi

now="$(date +%s)"
for kind in pnpm compiler; do
  if [[ "$kind" = pnpm ]]; then
    prefix=anderson-pnpm-
    limit_kib=$((2 * 1024 * 1024))
    idle_seconds=$((90 * 24 * 60 * 60))
  else
    prefix=anderson-next-
    limit_kib=$((512 * 1024))
    idle_seconds=$((30 * 24 * 60 * 60))
  fi
  while IFS= read -r volume; do
    if [[ -n "$selected_volume" && "$volume" != "$selected_volume" ]]; then
      continue
    fi
    [[ "$volume" =~ ^${prefix}[0-9a-f]{64}$ ]] || continue
    repository="$(docker --context colima volume inspect \
      --format '{{ index .Labels "anderson.repository" }}' "$volume")"
    [[ "$repository" =~ ^anderson-webops/[a-z0-9][a-z0-9.-]+$ ]] || continue
    usage="$(docker --context colima run --rm --network none --read-only \
      --mount "type=volume,src=$volume,dst=/cache,readonly" \
      --entrypoint sh "$image" -c \
      'du -sk /cache | cut -f1; if test -f /cache/.anderson-last-used; then stat -c %Y /cache/.anderson-last-used; else echo 0; fi')"
    size_kib="${usage%%$'\n'*}"
    last_used="${usage##*$'\n'}"
    [[ "$size_kib" =~ ^[0-9]+$ && "$last_used" =~ ^[0-9]+$ ]] || exit 1
    if [[ "$last_used" = 0 ]]; then
      created="$(docker --context colima volume inspect --format '{{.CreatedAt}}' "$volume")"
      last_used="$(node -e '
        const epoch = Date.parse(process.argv[1]);
        if (!Number.isFinite(epoch)) process.exit(1);
        process.stdout.write(String(Math.floor(epoch / 1000)));
      ' "$created")"
    fi
    age_seconds=$((now - last_used))
    if (( age_seconds < 0 )); then
      printf 'Skipping cache with an invalid future timestamp: %s\n' "$volume" >&2
      continue
    fi
    if (( size_kib <= limit_kib && age_seconds <= idle_seconds )); then
      printf 'retain %s %s %s KiB %s days\n' "$kind" "$volume" "$size_kib" "$((age_seconds / 86400))"
      continue
    fi
    if [[ -n "$(docker --context colima ps -a --filter "volume=$volume" --format '{{.ID}}')" ]]; then
      printf 'in-use %s %s %s KiB\n' "$kind" "$volume" "$size_kib"
      continue
    fi
    if [[ "$apply" = true ]]; then
      docker --context colima volume rm "$volume" >/dev/null
      printf 'removed %s %s %s KiB\n' "$kind" "$volume" "$size_kib"
    else
      printf 'eligible %s %s %s KiB %s days\n' "$kind" "$volume" "$size_kib" "$((age_seconds / 86400))"
    fi
  done < <(docker --context colima volume ls \
    --filter "label=anderson.cache-kind=$kind" --format '{{.Name}}')
done
