# Image components and licences

Runtime software is drawn from Debian main and the upstream open-source releases
below. No proprietary model client, provider key or restricted database is added.

| Component | Pin | Licence / source |
|---|---|---|
| Debian bookworm slim | `bookworm-20260918-slim`, digest in Dockerfile | Debian main; GPL, LGPL, BSD, MIT and other free software licences; per-package copyright retained |
| Debian packages and libraries | signed archive `20261001T000000Z` | exact versions and full notices in `/opt/computer/licences/debian.json` and `debian-copyright/` |
| Node.js | 22.23.3, SHA-256 in Dockerfile | [MIT and bundled notices](https://github.com/nodejs/node/blob/v22.23.3/LICENSE) |
| Codex | 0.159.3, npm integrity lock | [Apache-2.0](https://github.com/openai/codex/blob/main/LICENSE) |
| Playwright MCP | 0.0.83, npm integrity lock | [Apache-2.0](https://github.com/microsoft/playwright-mcp/blob/main/LICENSE) |
| Playwright / Chromium | npm lock pins Playwright; it pins browser revision | [Apache-2.0](https://github.com/microsoft/playwright/blob/main/LICENSE) / [BSD-3-Clause plus bundled licences](https://chromium.googlesource.com/chromium/src/+/main/LICENSE) |
| KasmVNC | 1.5.0, SHA-256 in Dockerfile | [GPL-2.0](https://github.com/kasmtech/KasmVNC/blob/v1.5.0/LICENSE.TXT) |
| MarkItDown | 0.1.8 | [MIT](https://github.com/microsoft/markitdown/blob/main/LICENSE) |
| Python libraries | exact versions in `constraints.txt` | machine-readable installed declarations in `/opt/computer/licences/python.json` |
| poppler-utils | Debian archive pin | GPL-2.0-or-later; installed copyright |
| Openbox | Debian archive pin | GPL-2.0-or-later; installed copyright |
| Supervisor | Debian archive pin | BSD-derived; installed copyright |
| Python 3 | Debian archive pin | PSF-2.0 and bundled notices |
| X11 utilities | Debian archive pin | MIT/X11; installed copyright |
| Liberation fonts | Debian archive pin | SIL OFL-1.1 |
| TypeScript (build only) | 5.9.3 | Apache-2.0 |
| Node types (build only) | 22.20.4 | MIT |
| Cloud Build Docker builder (build only) | digest in `cloudbuild.yaml` | Apache-2.0; Docker/Moby Apache-2.0 |
| Agent Sandbox (managed separately) | GKE 1.36.4-gke.1247000 | [Apache-2.0 upstream](https://github.com/kubernetes-sigs/agent-sandbox/blob/v1.0.4/LICENSE) |
| gVisor (managed separately) | selected GKE node image | [Apache-2.0](https://github.com/google/gvisor/blob/master/LICENSE) |

The final image removes npm/npx because npm bundles SPDX data under CC0 and
CC-BY. Those data packages are allowed only at build time. Pip and setuptools
are also removed after building the Python environment. Node and the installed
applications continue to work without these installers.

`licences.mjs` inventories runtime npm packages and rejects unreviewed licence
identifiers. `inventory.py` records Python metadata and every Debian package's
name/version/licence declarations, copying full copyright texts (including
older prose notices). Node's licence is retained at `/usr/local/LICENSE`.
Chromium's bundled third-party notices remain with its distribution.

A Debian copyright file can describe source documentation or build tools in
addition to runtime binaries. The inventory retains those notices rather than
pretending each package has a single SPDX licence. This is a component inventory,
not a completed legal audit of every bundled source file.

## Strict licence clearance: BLOCKED

NumPy **2.4.6**, pulled in by MarkItDown/Magika and pandas, declares
`BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0`. See the exact declaration
in [the pinned upstream metadata](https://github.com/numpy/numpy/blob/v2.4.6/pyproject.toml)
and the [installed inventory](evidence/python.json).

The CC0 notice is for SplitMix64. Source inspection found references only in
test-data generators and a benchmark, outside the extension targets in
`numpy/random/meson.build`. The installed wheel lists only its `LICENSE.md`
under a SplitMix64 path, not a source file or executable. The scripted
[evidence](evidence/numpy-licence-review.txt) records this, but does not prove
that no inlined CC0 code exists in every compiled object. Older NumPy 2.3.5
also contains the same upstream source: hiding the newer metadata by downgrading
would not establish compliance.

No exception to the OSI-only rule has been assumed. The image is a **functional
spike artifact, not cleared for customer use**. Resolving this requires an
upstream licence/build clarification or an audited wheel built without the
CC0 component. The cluster is paused after testing, so no computer image is
left running. This does not invalidate the recorded functional smoke results.

Build-only installers: npm 10.9.9 (Artistic-2.0 and bundled notices), pip 25.3
(MIT), setuptools 80.9.0 (MIT). Their runtime copies were removed. The NumPy
issue is separate from npm's removed SPDX data packages.
