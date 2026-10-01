# Computer image spike

**Functional smoke passes; strict licence clearance is BLOCKED.** NumPy 2.4.6
includes CC0 in its aggregate declaration. See [the review](LICENCES.md#strict-licence-clearance-blocked)
before promoting or reusing this as a customer image.

One non-root Debian 12 computer, built in Cloud Build and stored in the existing
`europe-west1-docker.pkg.dev/weownai-proto/ocn-spike` repository. No local Docker.
The image runs as uid/gid 1000. `/home/agent` is its scratch volume.

Supervisor starts five processes: KasmVNC 1.5.0 on display `:1`, Openbox,
Playwright's headed Chromium, idle Codex 0.159.3 app-server and the Node health
server. `GET :8080/health` reports each process's PID, uptime, Supervisor state
and a live probe. HTTP 200 means all are healthy; otherwise it returns 503.
`:8080/healthz` is a liveness check for the health server alone.

KasmVNC serves its web client and WebSocket on `:6901`. Codex (`:4500`) and
Chromium CDP (`:9222`) bind only to loopback. Playwright MCP 0.0.83 is installed
as `playwright-mcp`; it attaches to the visible Chromium via CDP and starts only
when invoked. MarkItDown 0.1.8 and poppler-utils provide document conversion.
All software pins and licence records are in [LICENCES.md](LICENCES.md).

The S0.1 bridge, local forwarding proxy, configuration helper and stub servers
are copied from `spikes/s0-1-codex/src` into the staged build context, compiled
strictly as ESM, and installed in `/opt/computer/spike-s0-1/`. Their source
checksums are kept in `SOURCES.sha256`; they do not start by default. This folder
does not edit S0.1's sources. No model key is configured and no model turn runs
in the smoke test. The smoke Pod denies all egress with NetworkPolicy.

## Build and smoke

```sh
export KUBECONFIG=/Users/jenterosseel/Documents/GitHub/opencrane-new/infra/spike-cluster/.state/kubeconfig
infra/spike-cluster/resume.sh --sandbox-nodes 1
spikes/computer-image/build.sh ocn-spike-example
spikes/computer-image/scripts/smoke.sh
infra/spike-cluster/pause.sh
```

`build.sh` stages only this image's inputs and the five S0.1 source files under
`.state/context`. It reserves build spend in the shared ledger before submitting
and records the successful immutable image digest in `.state/last-image.txt`.
Failed builds are charged to the estimate as well. The successful image must
pass the same self-test in a plain Cloud Build container before it is pushed.

`smoke.sh [IMAGE]` defaults to that digest. It creates one gVisor computer Pod,
checks its runtime placement, then reaches health and KasmVNC through a temporary
relay Pod on the default pool and `kubectl port-forward`. It also records whether
direct port-forward to the gVisor Pod works on this GKE version. Neither Pod has
a Service, NodePort, public ingress or load balancer. The relay is namespace
local and only forwards health and VNC. Local listeners bind to loopback.

The smoke script checks rendering and PNG output, the visible Chromium window,
VNC HTTP and WebSocket, Codex's initialise response and pinned version, the
Playwright MCP version, document conversion, non-root uid, listener exposure,
and clean bridge/proxy imports. It writes a random marker to `/home/agent`,
restarts Chromium and Codex, and asserts that both PIDs changed while the file
survived. It then restarts the whole container and checks the marker again,
with a disappearing file in `/var/tmp` as a negative control.

Evidence goes to `evidence/`: smoke output, screenshot, exact installed-package
versions/licences and copied-source checksums. Traps stop and wait for each local
port-forward. By default both Pods are deleted on exit. `--keep` retains the
Pods for manual inspection, but never leaves a local port-forward running.

## Findings and limits

- Chromium needs `--no-sandbox` here; isolation comes from the gVisor runtime.
- KasmVNC's IPv4 and IPv6 listeners collide on an internal socket in this
  configuration. `-UseIPv6 0` fixes it. `-PublicIP 127.0.0.1` prevents external
  IP discovery; only the WebSocket transport is used.
- KasmVNC requires an Origin header. The VNC test uses Chromium's WebSocket
  client; Node's default WebSocket client omits that header.
- Removing `xfonts-*` with apt also removes Openbox through its dependencies.
  The image removes only Xvfb, retaining the desktop's required fonts.
- Supervisor's XML-RPC response contains whitespace between tags. The health
  parser normalises that whitespace before reading its flat process records.
- NodeNext needs `type: module` during compilation and at runtime. The build
  fails on TypeScript errors rather than relying on emitted broken JavaScript.
- npm bundles CC0/CC-BY SPDX data. npm/npx, pip and setuptools are build-only and
  removed from the final image; Node and installed applications remain usable.
- `emptyDir` survives a **container restart**, not Pod deletion or scale-to-zero.
  This test does not qualify persistent assistant storage or snapshot restore.
- KasmVNC has no local password in this spike. A production deployment must put
  the authenticated OpenCrane view/control proxy and network policy in front of
  it. This task does not test user takeover authorisation.

Official references: [KasmVNC options](https://kasmweb.com/kasmvnc/docs/master/man/Xvnc.html),
[KasmVNC v1.5.0 listener source](https://github.com/kasmtech/KasmVNC/blob/v1.5.0/common/network/TcpSocket.cxx),
[KasmVNC WebSocket handshake](https://github.com/kasmtech/KasmVNC/blob/v1.5.0/common/network/websocket.c),
[Playwright browsers](https://playwright.dev/docs/browsers),
[Playwright MCP](https://github.com/microsoft/playwright-mcp),
[MarkItDown](https://github.com/microsoft/markitdown).

## Live results, 2026-10-01

Image: `europe-west1-docker.pkg.dev/weownai-proto/ocn-spike/computer:ocn-spike-20261001-05`

Digest: `sha256:68f51b46813e69c144579205f16ac845f92a872e037fd419cb6bf4312a68e3e8`

[Cloud Build](evidence/cloud-build.json) succeeded with [13/13 checks](evidence/cloud-build-selftest.txt).
The final [gVisor smoke](evidence/smoke-20261001T081430Z.txt) passed C1–C5:
placement, health/VNC through the relay, 13/13 application checks, process
restart persistence, and container restart persistence with a negative control.
The first cold run reached Ready in 107 seconds, including scale-up from zero
and a 30-second image pull (740,165,134 compressed bytes).

Direct port-forward: **BLOCKED** by the sandbox network namespace; the actual
connection-refused error is retained in both smoke records. The relay path
returned HTTP 200 for health and KasmVNC. The runtime kernel is
`4.19.0-gvisor`; the initial test's obsolete `4.4.0` assertion was corrected and
the full test rerun. Both the initial failure and final result are retained.

[Chromium screenshot](evidence/chromium-gvisor.png),
[npm packages](evidence/components.txt), [Debian packages](evidence/debian.json),
[Python packages](evidence/python.json), [source checksums](evidence/bridge-sources.sha256).

Snapshot capture/restore and authenticated user takeover: **NOT_RUN**.

