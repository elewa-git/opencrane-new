#!/bin/bash
# Called by run-real.sh with the secret pattern on fd 3. Never run by the
# implementation agent. This script has no credential path or key argument.
set +x
set +v
set -euo pipefail
ulimit -c 0
cd "$(dirname "$0")/.."
exec node scripts/leak-scan.mjs "$PWD" /private/tmp/claude-501 "${SCAN_HOME:?}/.codex/shell_snapshots"
