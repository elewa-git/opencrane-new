#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
state=$(mktemp -d)
trap 'rm -rf "$state"' EXIT HUP INT TERM
mkdir -p "$state/root/node_modules/licence-probe"
printf '%s\n' '{"name":"licence-probe","version":"1.0.0","license":"MIT"}' > "$state/root/node_modules/licence-probe/package.json"
.state/syft scan --select-catalogers +javascript-package-cataloger "dir:$state/root" -o "syft-json=$state/allowed.json"
python3 check-licences.py "$state/allowed.json" .state/osi.json "$state/inventory.json"
printf '%s\n' '{"name":"licence-probe","version":"1.0.0","license":"BUSL-1.1"}' > "$state/root/node_modules/licence-probe/package.json"
.state/syft scan --select-catalogers +javascript-package-cataloger "dir:$state/root" -o "syft-json=$state/denied.json"
if python3 check-licences.py "$state/denied.json" .state/osi.json "$state/inventory.json" > "$state/result" 2>&1; then
  echo 'FAIL: non-OSI package accepted' >&2
  exit 1
fi
rg -q 'FAIL licence-probe@1.0.0: BUSL-1.1' "$state/result"
echo 'PASS: real SBOM accepts MIT and rejects injected BUSL-1.1 package'
printf '%s\n' '{"name":"licence-probe","version":"1.0.0","license":"CC0-1.0"}' > "$state/root/node_modules/licence-probe/package.json"
.state/syft scan --select-catalogers +javascript-package-cataloger "dir:$state/root" -o "syft-json=$state/cc0.json"
if python3 check-licences.py "$state/cc0.json" .state/osi.json "$state/inventory.json" > "$state/result" 2>&1; then
  echo 'FAIL: application CC0 accepted' >&2
  exit 1
fi
rg -q 'FAIL licence-probe@1.0.0: CC0-1.0' "$state/result"
python3 test/licences.py
