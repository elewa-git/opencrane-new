#!/bin/bash
# Copied and narrowed from S0.2. Only agentgateway is needed here.
set -euo pipefail
cd "$(dirname "$0")/.."
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) platform=darwin-arm64; expected=da432d35bd696da0564f7b2b6bbc783542b6b9c616d6c0c4d4c3daef9dfa11a1 ;;
  Linux-x86_64) platform=linux-amd64; expected=daca5cda76e8c5ab0c1a75912fecf2d6365095403f810db72029c49d14a37e7b ;;
  *) echo 'Unsupported platform'; exit 1 ;;
esac
mkdir -p .tools
binary=".tools/agentgateway-$platform"
check() { echo "$expected  $binary" | shasum -a 256 -c - >/dev/null 2>&1; }
if ! check; then
  curl --fail --silent --show-error --location "https://github.com/agentgateway/agentgateway/releases/download/v1.5.0/agentgateway-$platform" -o "$binary"
  check || { rm -f "$binary"; exit 1; }
fi
chmod +x "$binary"
