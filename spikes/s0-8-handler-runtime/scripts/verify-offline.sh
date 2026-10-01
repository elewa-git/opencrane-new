#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
for n in 1 2 3; do bash scripts/run-all.sh "offline-$n" offline; done
