#!/bin/sh
# Build the real upload computer from public pins, without publishing or starting a stack.
set -eu
cd "$(dirname "$0")/.."
docker buildx bake -f apps/computer/test/upload-bake.hcl --load "$@"
