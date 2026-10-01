#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
[[ "$(node -p 'process.versions.node.split(".")[0]')" == 22 ]]
mkdir -p .state
bash scripts/fetch-tools.sh
for round in 1 2 3; do
  echo "Clean stub round $round"
  npm run typecheck
  npm test
done
