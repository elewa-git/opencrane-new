#!/bin/sh
# Refresh a candidate on the dev box; never change a running scanner's pinned database.
set -eu
exec node "$(dirname "$0")/refresh.mjs" "$@"
