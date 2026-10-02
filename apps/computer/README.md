# Computer image — P2-1

Product runtime promoted from S0.1b, S0.3 and S0.5. **Qualification is blocked by
runtime licence findings**. The functional test candidate lives only in the
local registry; `build.sh` refuses to publish the product tag while the strict
OSI licence gate fails. This is not a completed Phase 2 capability.

## Build and check

On the [developer box](../../infra/devbox/README.md), with the pinned S0.5 image
already present in its local registry, Docker, Node 22, Python 3, curl, tar,
sha256sum, kubectl and the root workspace dependencies:

```sh
apps/computer/build.sh
node apps/computer/test/run.mjs
apps/computer/test/licences.sh
shellcheck apps/computer/build.sh apps/computer/test/licences.sh
```

The build uses the S0.5 digest, including its Node 22.23.1, Codex 0.159.2,
Chromium 154 and KasmVNC 1.5.0. Python 3.11 and every added Debian package are
version-locked against the signed 1 October 2026 Debian snapshot. MarkItDown
0.1.8 and its PDF/Office dependencies are pinned to wheel hashes. Playwright
Core 1.63.0 uses the installed Chromium; its npm lock retains package integrity.
MarkItDown is MIT, Playwright Core Apache-2.0 and Python PSF-2.0;
installed package notices supply the dependency-level inventory. Syft is
Apache-2.0. Build tools and SPDX data never enter the runtime. MinIO is absent.
Reproduction requires these pinned upstream artefacts and the local spike base;
bit-for-bit rebuilding on another host has not been qualified.

Syft 1.54.0 produces `.state/sbom.syft.json` and `.state/sbom.spdx.json`;
`check-licences.py` produces `.state/licences.json` and rejects absent,
unrecognised and non-OSI licence expressions. It understands SPDX AND/OR,
accepting an OSI alternative for OR and requiring every AND component to pass.
Its OSI list and scanner downloads have fixed hashes. Copyright files and
notices stay in the image. A successful build pushes only to
`127.0.0.1:5001/opencrane/computer:p2-1`, recording the digest and size in `.state/`.
The injected installed-package test proves MIT succeeds and BUSL-1.1 fails
through the real scanner and the same gate.

The scan exposes non-OSI licences in the inherited image, including
Bitstream-Vera fonts and public-domain SQLite/tzdata. It also finds source and
documentation notices that require a file-level audit, and binaries with no
scanner-detected licence. These are **unresolved**, not an automatic allowlist.
The preceding spike's manual OSI claim is insufficient for this stricter gate.
No exception or false OSI mapping has been added. Broadening the policy or
replacing affected contents needs an explicit decision before product release.

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
