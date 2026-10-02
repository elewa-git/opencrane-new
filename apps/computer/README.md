# Computer image — P2-1

Product runtime promoted from S0.1b, S0.3 and S0.5. The complete notice gate
accepts 382/382 packages. ONNX Runtime is retained: its wheel contains no
Intel MKL component. The two unlicensed lxml Schematron extraction stylesheets
are removed. Both decisions require reviewed, exact installed-file evidence.

The checked template pins the tested release image at
`sha256:4dbe85e978021417c8e3fa509da2af5b8ab608f126dc5c92c04a89242ea43156`.
It is published as `127.0.0.1:5001/opencrane/computer:p2-1` after fresh and
resumed k3d checks. See [evidence.json](evidence.json).

## Build and check

On the [developer box](../../infra/devbox/README.md), with the pinned S0.5 image
in its local registry, Docker, Node 22, Python 3, curl, tar, sha256sum, kubectl
and the root workspace dependencies:

```sh
apps/computer/test/licences.sh
apps/computer/build.sh
shellcheck apps/computer/build.sh apps/computer/test/licences.sh
```

`build.sh` collects and checks notices, publishes a qualification digest, updates
the tracked manifest, runs the real k3d checks and only then moves `p2-1`. A
failed licence or image check cannot publish the release.

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
  3.28 list, plus the owner-approved PSF-2.0, Python-2.0, Python-2.0.1 and
  HPND variants (including MIT-CMU). SPDX AND/OR syntax is parsed; unknown
  terms fail, including unknown OR alternatives. The primary licence must
  pass this rule even when a bundled part has a free non-OSI notice.
- Bundled DFSG-free notices require a package/version-specific record naming
  the component, licence, source and reason. Node's LICENSE separates its MIT
  core from externally maintained libraries; wheel METADATA and licence files
  identify their primary and bundled terms. These are reviewed distinctions,
  never inferred by subtracting non-OSI terms from a scanner expression.
- BUSL, SSPL, Elastic, KLv1, Commons Clause and related source-available notices
  fail in either layer, including when another licence or mapping is present.
  Boost's `BSL-1.0` is distinct from `BUSL-1.1`.
- [reviewed-licences.json](reviewed-licences.json) identifies all 42 original
  scanner text hashes and scopes unusual Debian labels to exact copyright
  texts. Each entry names its source and reason. Application corrections check
  exact package/version, scanner metadata and every collected metadata/notice
  file hash for **every** application package, including ordinary MIT packages. Missing, changed or additional files fail. Forbidden terms are
  checked before licence mappings, including inside bundled text. A component
  notice can be excluded only with a reviewed proof tied to the exact installed
  file inventory; only its specified lines are excluded. Missing evidence,
  changed binaries, added files or present excluded components fail.

Syft 1.54.0 produces `.state/sbom.syft.json` and `.state/sbom.spdx.json`.
Installed notices and apt matches form `.state/licence-evidence.json`;
`.state/licences.json` includes the resulting decisions and archive evidence.
The inventory also includes OpenCrane code and its inherited native launcher
under the repository AGPL-3.0-or-later notice, copied into `/app/LICENSE`.
Codex's native npm bundle includes checked Apache, BSD, MIT, Zlib and LGPL
notices. The scanner's previously unlicensed binary is Node, not Codex.

The collector includes NOTICE, NOTICE.md, ThirdPartyNotices*, COPYING*,
LICEN[CS]E* and metadata-named files, including Python RECORD-owned files outside
`dist-info`. Every collected notice must belong to a scanned package and have
an exact reviewed hash and primary/bundled classification. The independent
image completeness check covers 89 installed notice and metadata-named files.
Regressions reject an ordinary MIT package with a redistribution-forbidden
notice, unlisted NOTICE files and missing metadata-named files.

ONNX Runtime 1.30.0's omnibus notice names Intel MKL, but the installed wheel
contains only `libonnxruntime.so.1.30.0`, `libonnxruntime_providers_shared.so`,
`onnxruntime_pybind11_state.cpython-311-x86_64-linux-gnu.so` and the Python
`onnxruntime_test` CLI wrapper. The review records their hashes, SONAMEs and
NEEDED libraries, symbol/string checks, the 325-file inventory hash and CPU/Azure
provider results. No MKL or Intel-restricted runtime is shipped. Generic
DNNL/OpenVINO loader names remain, with no matching provider libraries.
The same inspection excludes RapidJSON's JSON-licensed `bin/jsonchecker` test
data; its MIT runtime notice remains checked. MarkItDown 0.1.8 imports magika
unconditionally, so both magika and ONNX Runtime are retained.

For lxml 6.1.3, the Dockerfile removes only `RNG2Schtrn.xsl` and `XSD2Schtrn.xsl`.
Searching installed code finds references only inside `lxml.isoschematron`
itself; that unused module can no longer be imported. The checker requires
both files to be absent and pins the remaining 174-file inventory. BSD-3-Clause
and the other reviewed bundled grants and notice files remain intact. Tests
restore each stylesheet and a dangling link in the actual image and require
rejection. Fresh and resumed checks convert PDF, DOCX, XLSX and PPTX documents.

The previously reviewed Python notices remain classified. Defusedxml uses
PSF-2.0; typing-extensions uses PSF/Python with 0BSD examples; Pillow's primary
MIT-CMU is an HPND variant. The free bundled notices are:

| Package (primary) | Bundled free notices beyond the OSI list |
| --- | --- |
| Node (MIT) | ICU timezone code/data: public domain |
| ONNX Runtime (MIT) | SQLite and libb64: public domain |
| NumPy (BSD-3-Clause) | SplitMix64 and Highway random-inl.h: CC0-1.0 |
| pandas (BSD-3-Clause) | UltraJSON's Tcl-derived code: TCL |
| Pillow (MIT-CMU) | FreeType: FTL; MD5/XZ/liblzma: public domain; JPEG: IJG; Tcl/Tk: TCL; bzip2: bzip2-1.0.6; PNG: libpng-2.0; TIFF: libtiff; Xau/Xdmcp: X11 |
| pypdfium2 (Apache-2.0/BSD-3-Clause) | FreeType: FTL; JPEG: IJG; ICU timezone: public domain; PNG: libpng-2.0; TIFF: libtiff; accompanying documentation/examples: CC-BY-4.0 |
| xlrd (BSD-3-Clause) | Earlier Giffin/Khan code: BSD advertising/acknowledgement variant |

The per-package records also retain OSI bundled grants and their sources.
The full [inventory](licences.json) separates primary results from bundled
notices. Tests include real Syft MIT/BUSL/primary-CC0 npm probes, acceptance of
an OSI package with a reviewed CC0 part, refusal of a BUSL part even behind a
CC0 mapping, unknown/changed/additional notices and Debian archive checks.
A failed gate cannot publish `127.0.0.1:5001/opencrane/computer:p2-1`.
Playwright NOTICE, ThirdPartyNotices.txt and all three sidecars now name their
bundled OSI terms; Codex voice NOTICE.md is pinned with the Linux voice grants.
Its Windows-only Visual C++ paragraph does not describe this Linux bundle.

## Processes and storage

- The root supervisor accepts only a fixed native exec-server launch over a
  private Unix socket in root-owned `/run/executor` (0750, group 1000). `tool-user.c` is unchanged from S0.1b; the executable is
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
  the existing Chromium with `chromiumSandbox: true`, inside gVisor.
- `/home/agent` itself is root-owned 0755. UID 1000/1001/1002 cannot replace
  its children; each writes only inside its own directory. Startup refuses
  links and non-directories with lstat, O_NOFOLLOW and O_DIRECTORY; ownership
  and mode changes use the checked descriptor through an open parent. It
  leaves already-correct directories alone and fails closed on any error.
  The root filesystem is read-only; supervisor code and binaries cannot be
  written by agent UIDs. Python bytecode and Node compile caches are removed.
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
The gateway is the documented `computer-runtime` ConfigMap parameter, key
`gateway`. Create it in the computer namespace with the real gateway Pod IP
and port (DNS is deliberately unavailable):

```sh
kubectl -n "$namespace" create configmap computer-runtime \
  --from-literal=gateway="http://$gateway_ip:3000"
kubectl -n "$namespace" apply -f apps/computer/network-policy.json
kubectl -n "$namespace" apply -f apps/computer/sandbox-template.json
```

The test applies the tracked manifest byte-for-byte, with no image, environment
or probe-volume substitutions. During qualification, `build.sh` pins the candidate digest, then promotes that
same digest to the release tag only after all image checks pass. The neutral template has `emptyDir` home storage;
lifecycle work selects a PVC before Pod creation. A running warm Pod cannot
have its volume replaced (ADR 0006).

The runner refuses an existing `p21-computer` namespace. It creates a zero-size
warm pool and a real claim, measures cold-Pod readiness, checks CRI's runsc
runtime, and deletes the namespace in `finally`. It reuses S0.1b's actual
agentgateway, scripted Responses provider and model-requested isolation probe;
only identity issuance and model replies are scripted. The provider fixture asks Codex to execute the probe copied into the test
workspace; it is never included in the product image. Desktop checks inspect
real Chromium/Xvnc UIDs and `NoNewPrivs`, then render text with Playwright.
MarkItDown reads generated PDF, DOCX, XLSX and PPTX documents as UID 1001.
Network checks include a removed-policy positive control. A second real gVisor
Sandbox suspends with a local-path PVC. UID 1001 replaces its workspace with a
link to `/usr/local/bin`, a FIFO and a dangling link in turn, using a legacy
0777 volume root. The real entrypoint refuses each; target ownership, mode and
launcher hash remain unchanged. Resume retains the PVC and a canary file,
repairs the writable root, creates a new Pod and repeats all isolation,
browser, document and network checks. No paid calls or
running dev-stack changes are involved. An externally killed runner may require
`kubectl delete namespace p21-computer`.

See [evidence.json](evidence.json) for exact results, digest, size and latency.
NOT RUN: fresh silo, paid model, product bridge/chat/upload, full product recovery
journey, encrypted storage/cloud/CSI, live viewer/takeover, long-lived capability
renewal, clean-host rebuild and independent review (explicitly excluded).
