#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Default is a fully local stub. An already-authorised real gateway can be
# queried by passing its loopback proxy URL; this script never reads a key.
if [[ $# == 1 ]]; then
  node --input-type=module - "$1" <<'JS'
const url = new URL(process.argv[2]);
if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/') process.exit(1);
const r = await fetch(new URL('/v1/models', url));
if (!r.ok) process.exit(1);
const data = await r.json();
for (const item of data.data) if (/^[a-zA-Z0-9._-]+$/.test(item.id)) console.log(item.id);
JS
else
  mkdir -p .state
  run_dir="$(mktemp -d "$PWD/.state/list-XXXXXX")"
  trap 'rm -rf "$run_dir"' EXIT
  node_modules/.bin/tsx scripts/runner.ts list "$run_dir"
fi
