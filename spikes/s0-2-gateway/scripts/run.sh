#!/usr/bin/env bash
# One-command entry point for spike S0.2.
#
# Plain-English summary: installs dependencies if needed, then runs the
# whole test suite. The test suite itself starts and stops every process
# (OpenFGA, agentgateway, the token issuer, the decision service, the two
# stub backends) -- this script does not start anything long-running of
# its own, and leaves nothing behind when it finishes.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "== disk space before running =="
df -h / | tail -1

if [ ! -d node_modules ]; then
  echo "== installing dependencies =="
  npm install
fi

echo "== type-checking =="
npx tsc --noEmit

echo "== running the S0.2 spike test suite (starts/stops its own processes) =="
npx vitest run

echo "== disk space after running =="
df -h / | tail -1
