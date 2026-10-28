#!/usr/bin/env bash
set -euo pipefail

# Select linux/amd64 manifests from these indexes with docker buildx imagetools inspect --raw.
# Skip index attestations because the pull-through mirror may not have their blobs.
images=(
  # Index: sha256:cf23643a6cf9ce159c57643ceb88279e431262282428c9e0bf3a7ef1a97e84b4
  'mirror.gcr.io/alpine/minio:RELEASE.2025-10-15T17-29-55Z@sha256:f93b327d2d9a81ef9d9a966d2c7fbe3ea4d657d23ed412566c20d488e9f73332'
  # Index: sha256:14e2e0805c6a5ff6728ea591c05565e0f0954d93e8701919012c3a8c44e20674
  'mirror.gcr.io/clamav/clamav-debian:1.5.2@sha256:24b4b24c303efed21633b29d61096fab4a8a7e158a595149238c7bef7b39873c'
  # Index: sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3
  'mirror.gcr.io/library/node:22.23.1-bookworm-slim@sha256:8607a9064d4a571140998ae9e52a3b3fcf9cff361d04642d5971e6cd76d39e27'
  # Index: sha256:2113c664a486b5da8d7a2cdab479e0d4e30639c80fd2c000540f645c1dbc1e55
  'ghcr.io/openfga/openfga:v1.21.0@sha256:51bece5c31783bfeb150eae0f1c818ae804c50d39e0a311c43ff5357fed6debd'
)
pull_log=$(mktemp)
trap 'rm -f "$pull_log"' EXIT

transient_failure() {
  local status=$1
  local permanent_errors='(^|[^[:alnum:]])404([^[:alnum:]]|$)'
  permanent_errors+='|manifest unknown|manifest_unknown|name unknown|name_unknown'
  permanent_errors+='|unknown digest|digest unknown|digest_unknown|unauthorized|denied'
  # Refuse permanent errors even when another line mentions a temporary failure.
  if grep -Eqi "$permanent_errors" "$pull_log"; then
    return 1
  fi
  if (( status == 124 || status == 137 )); then
    return 0
  fi
  local transient_errors='(^|[^[:alnum:]])(429|5[0-9]{2})([^[:alnum:]]|$)'
  transient_errors+='|too many requests|toomanyrequests|quota exceeded|rate limit'
  transient_errors+='|timeout|timed out'
  transient_errors+='|failed to copy: httpReadSeeker|could not fetch content descriptor'
  transient_errors+='|deadline exceeded|connection reset|unexpected EOF'
  grep -Eqi "$transient_errors" "$pull_log"
}

pull_image() {
  local image=$1
  local attempt=1
  local backoffs=(10 30 60)
  local backoff
  local status
  while true; do
    printf 'Pulling test image (attempt %s of 4): %s\n' "$attempt" "$image"
    if timeout --kill-after=5s 90s docker pull "$image" > "$pull_log" 2>&1; then
      cat "$pull_log"
      return 0
    else
      status=$?
    fi
    cat "$pull_log" >&2
    if (( attempt == 4 )) || ! transient_failure "$status"; then
      return "$status"
    fi
    # Allow a per-minute quota to reset and spread concurrent jobs by up to two seconds.
    backoff=$((backoffs[attempt - 1] + RANDOM % 3))
    printf 'Temporary image pull failure; retrying in %s seconds.\n' "$backoff" >&2
    sleep "$backoff"
    attempt=$((attempt + 1))
  done
}

# Prepare these exact pins once per job so parallel tests start from local images.
for image in "${images[@]}"; do
  pull_image "$image"
done
