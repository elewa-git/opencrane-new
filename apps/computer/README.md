# Computer image — P2-1

Product runtime promoted from S0.1b, S0.3 and S0.5. **Release remains blocked
by application licence findings** under the owner's two-layer rule. Functional
qualification uses a candidate in the local registry. `build.sh` publishes the
release tag only after the licence gate passes.

## Build and check

On the [developer box](../../infra/devbox/README.md), with the pinned S0.5 image
in its local registry, Docker, Node 22, Python 3, curl, tar, sha256sum, kubectl
and the root workspace dependencies:

```sh
apps/computer/build.sh
apps/computer/test/licences.sh
node apps/computer/test/run.mjs
shellcheck apps/computer/build.sh apps/computer/test/licences.sh
```

The image retains Node 22.23.1, Codex 0.159.2, Chromium 154 and KasmVNC 1.5.0
from the pinned S0.5 digest. Added apt packages use the signed 1 October 2026
snapshot and `apt.lock`. The 2 October snapshot supplies additional archive
evidence for inherited packages; it is added after installation and removed
after collection. Python wheels use exact versions and hashes; Playwright Core
1.63.0 uses installed Chromium. No dependencies have been replaced in this
change. Build tools and SPDX data stay outside the runtime.

`collect-licences.py` matches every installed Debian package's name, version
and architecture against apt-authenticated snapshot indexes. The retained
`/usr/share/opencrane/apt-packages.json` records archive component, index URL
and checksum, package filename and checksum. A package name or a `Section`
label alone is insufficient. Missing matches, contrib, non-free and
non-free-firmware fail. Debian security's `pool/updates/main` layout is handled.
KasmVNC is a pinned third-party local deb, so its GPL notice is checked as an
application; it receives no Debian-main exception.

`check-licences.py` applies these rules:

- Debian main permits DFSG-free notices, including public domain, CC0, Unicode,
  X11, HPND, FSF permissive notices, GPL/LGPL short labels and OFL fonts.
  [Debian policy](https://www.debian.org/doc/debian-policy/ch-archive.html#the-main-archive-area)
  defines the archive boundary.
- Applications require OSI-approved identifiers from the checksum-pinned SPDX
  3.28 list. SPDX AND/OR syntax is parsed; every identifier must be approved.
  Unknown terms fail, including unknown OR alternatives.
- BUSL, SSPL, Elastic, KLv1, Commons Clause and related source-available notices
  fail in either layer, including when another licence or mapping is present.
  Boost's `BSL-1.0` is distinct from `BUSL-1.1`.
- [reviewed-licences.json](reviewed-licences.json) identifies all 42 original
  scanner text hashes and scopes unusual Debian labels to exact copyright
  texts. Each entry names its source and reason. Application corrections check
  exact package/version, scanner metadata and installed notice hashes.
  Changed or unknown text requires a new examination; hashes are never an
  unconditional allowlist.

Syft 1.54.0 produces `.state/sbom.syft.json` and `.state/sbom.spdx.json`.
Installed notices and apt matches form `.state/licence-evidence.json`;
`.state/licences.json` includes the resulting decisions and archive evidence.
The inventory also includes OpenCrane code and its inherited native launcher
under the repository AGPL-3.0-or-later notice, copied into `/app/LICENSE`.
Codex's native npm bundle includes checked Apache, BSD, MIT, Zlib and LGPL
notices. The scanner's previously unlicensed binary is Node, not Codex.

The Python audit resolves missing cobble and pdfplumber metadata to BSD-2-Clause
and MIT; dateutil explicitly permits BSD-3-Clause for all its code. It also
exposes real blockers: NumPy includes CC0, Pillow uses MIT-CMU, xlrd includes
an unmatched advertising variant, and PDFium includes non-OSI FTL/IJG notices.
Defusedxml's PSF-2.0 and the Python-2.0.1 stack in typing-extensions and pandas
are not flagged OSI-approved by the pinned SPDX list. Node's ICU bundle
identifies public-domain timezone code/data. Unicode-3.0 and ICU themselves
are OSI-approved in the pinned list. None is silently relabelled MIT or Python-2.0.
The exact rejected identifiers and category counts are in
[evidence.json](evidence.json) and [licences.json](licences.json).

Tests retain the real Syft MIT/BUSL injection and add a real npm CC0 rejection.
Policy checks cover all three forbidden Debian components, Debian-main public
domain, unknown and changed text, absent archive evidence, exact version and
architecture, and source-available notices hidden beside an approved licence.
A failed gate cannot publish `127.0.0.1:5001/opencrane/computer:p2-1`.
Rebuilding on a clean host and replacing incompatible dependencies remain
unqualified; no release success is claimed.

## Processes and storage

- The root supervisor accepts only a fixed native exec-server launch over a
  private Unix socket. `tool-user.c` is unchanged from S0.1b; the executable is
  reused from the pinned base. UID 1001 inherits `no_new_privs` and the same
  seccomp rules denying sockets, process inspection and alternative syscall ABIs.
- The bridge stub, Codex and authenticated loopback model proxy use UID 1000.
  The stub initialises the real app-server and exposes `/health` on TCP 8081.
  Health requires initialised Codex and a listening desktop; required child exits
  terminate the container. A ready report is emitted when the first health check confirms both.
  The private `app.sock` is an owner-only test/future-bridge transport, not a
  public server API. P2-3 owns the actual inbound protocol and event dispatch.
- KasmVNC and browser checks use UID 1002 with `no_new_privs`. Kasm's stock UI and
  non-free recommended driver remain excluded as in S0.5. Playwright launches
  the existing Chromium, inside the outer gVisor boundary.
- `/home/agent/codex` (1000, 0700), `workspace` (1001, 0755) and `profile`
  (1002, 0700) are the persistent layout. `/home/codex`, `/run/codex` and
  `/home/desktop` are separate memory-backed volumes. Caller capabilities,
  per-thread grants and Kasm passwords never enter the persistent volume.

The proxy supports the existing Responses route. Its private control socket
accepts grants of at most two minutes and explicit drops. Calls without a live
thread grant or the ten-minute caller capability fail closed. Issuance, renewal,
turn completion handling, MCP and browser egress brokering belong to later
work; the stub does not claim to implement them. No provider key is embedded.

## Kubernetes and checks

`sandbox-template.json` uses agent-sandbox v1beta1, gVisor and S0.5's 512 MiB
limit. It declares `networkPolicyManagement: Unmanaged`; apply
`network-policy.json` before creating a pool. The policy permits TCP 3000 egress
only to `app=opencrane-gateway` and TCP 8081/6901 ingress only from
`app=opencrane-server`, both in the same namespace. There is no DNS exception.
Set the gateway environment to its IP and port, and the image to a checked
registry digest. The committed digest is a blocked test candidate, not a released
product image. The neutral template has `emptyDir` home storage; lifecycle
work must select a PVC before Pod creation for a bound computer. A running
warm Pod cannot have its volume replaced (ADR 0006).

The runner refuses an existing `p21-computer` namespace. It creates a zero-size
warm pool and a real claim, measures cold-Pod readiness, checks CRI's runsc
runtime, and deletes the namespace in `finally`. It reuses S0.1b's actual
agentgateway, scripted Responses provider and model-requested isolation probe;
only identity issuance and model replies are scripted. The probe is mounted
from a ConfigMap, never included in the product image. Desktop checks inspect
real Chromium/Xvnc UIDs and `NoNewPrivs`, then render text with Playwright.
MarkItDown reads generated PDF, DOCX, XLSX and PPTX documents as UID 1001.
Network checks include a removed-policy positive control. No paid calls or
running dev-stack changes are involved. An externally killed runner may require
`kubectl delete namespace p21-computer`.

See [evidence.json](evidence.json) for exact results, digest, size and latency.
NOT RUN: fresh silo, paid model, product bridge/chat/upload, PVC replacement
journey, encrypted storage/cloud/CSI, live viewer/takeover, long-lived capability
renewal, clean-host rebuild and independent review (explicitly excluded).
