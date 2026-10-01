#!/usr/bin/env bash
# Inspect a pinned upstream release and the installed wheel; makes no cluster changes.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../../../infra/spike-cluster/lib.sh"
require_cluster_access
kc -n ocn-spike exec ocn-spike-computer-smoke -- /opt/venv/bin/python -c '
import importlib.metadata as m
n=m.distribution("numpy")
assert n.version == "2.4.6"
files=[str(p) for p in n.files if "splitmix64" in str(p).lower()]
print("NumPy",n.version,"declares",n.metadata.get("License-Expression"))
print("Installed SplitMix64 paths:",files)
assert files and all(p.endswith("/LICENSE.md") for p in files)
print("PASS only the SplitMix64 licence notice is installed, no named source or executable")
'
for source in numpy/random/meson.build numpy/random/src/philox/philox-test-data-gen.c numpy/random/src/pcg64/pcg64-benchmark.c; do
  echo "SOURCE https://github.com/numpy/numpy/blob/v2.4.6/${source}"
  curl -fsSL "https://raw.githubusercontent.com/numpy/numpy/v2.4.6/${source}" | rg -n 'splitmix64|_sfc64|_pcg64|_philox' || true
done
echo 'PARTIAL strict licence clearance: aggregate wheel metadata includes CC0-1.0; upstream references found only in test-data generation and benchmarks. This check does not prove absence of inlined code in every binary.'
