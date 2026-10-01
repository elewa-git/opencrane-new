#!/bin/sh
set -eu
cd "$(dirname "$0")/../.."
exec flock "/tmp/opencrane-dev-stack-$(id -u).lock" node --experimental-strip-types infra/dev-stack/stack.ts status "$@"
