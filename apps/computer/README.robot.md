# Computer image — P2-1

For people, read [README.md](README.md) first.

Product runtime promoted from S0.1b, S0.3 and S0.5. The complete notice gate
accepts 384/384 packages. ONNX Runtime is retained: its wheel contains no
Intel MKL component. The two unlicensed lxml Schematron extraction stylesheets
are removed. Both decisions require reviewed, exact installed-file evidence.

The template still names the previous memory-free image,
`sha256:688db3cbc1558d8ab2f5ffb2cd008ab05390489b83cc41effd6e0fb028189d77`.
The private build passed local filesystem and licence checks, but the local
registry refused its push. Its new digest and gVisor checks remain unqualified.
This lifecycle build adds `/credentials`: the worker POSTs a short-lived computer
credential through the Kubernetes Pod proxy; the bridge atomically stores it in
`/run/codex/computer.json` (UID 1000, mode 0600, memory-backed). The existing private
proxy control socket accepts per-thread grants. Model requests have a 2,000-token
output ceiling, including reasoning and tool-call syntax. The OS layer is unchanged from the P2-1 [licence and image evidence](evidence.json); that receipt
names the earlier image. The lifecycle k3d test checks delivery on the current digest. P2-3 adds the reviewed MIT `ws` package for the bridge channel.

## Build and check

On the [developer box](../../infra/devbox/README.md), with the pinned S0.5 image
in its local registry, Docker, Node 22, Python 3, curl, tar, sha256sum, kubectl
and the root workspace dependencies:

```sh
apps/computer/test/licences.sh
apps/computer/build.sh
shellcheck apps/computer/build.sh apps/computer/test/licences.sh
```

Both image commands need Docker and the dev stack's local Kubernetes cluster.
`build:image` also runs the image tests and updates `sandbox-template.json` with
the new image. `test:image` needs an image built first.

`build.sh` collects and checks notices, publishes a qualification digest, updates
the tracked manifest, runs the real k3d checks and only then moves `p2-1`. A
failed licence or image check cannot publish the release.

CI prepares the upload test with `sh scripts/build-test-computer.sh`. It rebuilds
the desktop/Codex base from public pins, then uses the production Dockerfile and
lockfiles to create `ocn-upload-computer:test` locally. No private registry, running
stack or pre-existing image is required. This test image is never published;
release builds keep the reviewed S0.5 base by default. Run the same preparation
before `npm test` on a clean Linux amd64 development machine. Hosted CI caches
the build layers, including the base and compiler stages, with Docker Bake.
The scanner fixture builds `infra/clamav` from its pinned public digest, including
offline signatures and excluding UnRAR.

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
image completeness check covers 91 installed notice and metadata-named files.
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

- The root supervisor accepts fixed native exec-server and code-mode host launches
  over separate private Unix sockets in root-owned `/run/executor` (0750, group
  1000). Both pass through `tool-user.c`: UID/GID 1001, no supplementary groups,
  a cleared environment, `no_new_privs` and the same S0.1b seccomp rules denying
  sockets, process inspection and alternative syscall ABIs. The image builds this
  launcher separately; compiler packages never enter the runtime. Codex starts
  only an IPC connector in place of its bundled host; the supervisor alone starts
  the relocated native host. Model-written JavaScript never runs as UID 1000.
- The bridge, Codex and authenticated loopback model proxy use UID 1000.
  The code-mode host and normal shell tools are enabled; tool output defaults to
  2,000 tokens and the proxy bounds each model response to 2,000 output tokens.
  Hosted web search stays disabled. Uploaded document context is described in
  [the upload contract](../../docs/architecture/upload-api.md#http-interface).
  The bridge initialises the real app-server and exposes `/health` on TCP 8081.
  Health requires initialised Codex and a listening desktop; required child exits
  terminate the container. A ready report is emitted when the first health check confirms both.
  The private `app.sock` is an owner-only image-test transport, not a
  public server API. The authenticated `/bridge` WebSocket drives conversation turns.
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
thread grant or the ten-minute caller capability, renewed by a trusted turn grant, fail closed. The bridge installs a grant before each turn and drops it on completion.
MCP and browser egress brokering remain later work. No provider key is embedded.

## Kubernetes and checks

`sandbox-template.json` uses agent-sandbox v1beta1, gVisor and S0.5's 512 MiB
limit. It declares `networkPolicyManagement: Unmanaged`; apply
`network-policy.json` before creating a pool. The policy permits TCP 3000 egress
only to `app=opencrane-gateway` and TCP 8081 ingress only from
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
the P2-2 lifecycle claim supplies the `home` volume claim template before Pod
creation, producing one PVC per computer. A running warm Pod cannot
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

P2-3 adds the existing workspace dependency ws 8.22.0 (MIT) to the image. Its
installed metadata and full licence are checksum-pinned in the reviewed licence
file. The bridge fsyncs reported events to a private PVC outbox before sending,
replays from the server acknowledgement, and waits for a fresh thread-bound grant
before execution. Prepared memory-free messages survive replacement and retry; unfinished private messages fail; a separate
fsynced execution marker prevents automatically repeating uncertain effects.
Older journals without that marker distinction remain uncertain. Saved Codex threads resume on the same PVC. Reports carry no turn
or computer credential. See [bridge evidence](../../docs/process/bridge-evidence.md).

## Private turns

Team messages default to `restricted`, unless posted with `memory_free`.
Each private turn opens a new Codex process and ephemeral thread as UID 1003.
It never resumes a thread. At most two private turns prepare or run together.
Its home is `/home/private/turn-<n>`, with config, temporary files and working
files inside. The supervisor removes it after the process exits. Socket closure
ends input; after 5 seconds it sends SIGKILL as UID 1003 if needed.
A private child error fails its own connection, rather than the supervisor.
Stderr is discarded. The whole container inherits a hard core-file limit of zero.

| Writable place | Backing | Who can write | Private text allowed? |
| --- | --- | --- | --- |
| Bridge memory | Process RAM | UID 1000 bridge | Yes, until acknowledged; swappable here |
| Supervisor stream buffers | Process RAM | Root supervisor | Yes, while passing bytes; swappable here |
| Private Codex memory | Process RAM | UID 1003 Codex | Yes; swappable here |
| `/home/private/turn-<n>` | 16Mi Memory volume | UID 1003 | Yes, only during its turn |
| `/home/agent/codex` | PVC | UID 1000 | No; only text-free private outlines |
| `/home/agent/workspace` (`/workspace`) | PVC | UID 1001; UID 1003 in world-writable directories | No |
| `/home/agent/profile` | PVC | UID 1002 | No |
| `/home/codex` | 16Mi Memory volume; `.codex` links to PVC | UID 1000 | No |
| `/run/codex` | 16Mi Memory volume | UID 1000 | No |
| `/home/desktop` | 16Mi Memory volume | UID 1002 | No |
| `/run/executor` | Node disk | Root | No |
| `/home/tool` | Node disk | UID 1001 | No |
| `/tmp` | Node disk | All users | No |
| `/dev/shm` | Runtime shared memory | All users | No |

All private processes share UID 1003. The kernel does not separate two members'
concurrent homes or processes; only the absence of tools does. UID 1003 can read
the workspace and reach loopback ports 8080, 8081 and 6901. Directory permissions
prevent reading `/run/executor`, `/run/codex`, `/home/codex`, `/home/agent/codex`
and `/home/tool`. Every UID 1000 process can reach `private.sock`, including
memory-free Codex and its connectors; this socket is not exclusive to the bridge.
Codex uses its RAM `TMPDIR`, but the kernel still permits writes to `/tmp`,
`/dev/shm` and world-writable workspace directories. The live probe checks them.

The PVC journal stores a text-free line for each private text report, marked
`memoryOnly: true`. Its text remains in bridge memory until acknowledged or
covered by `resume.since`. Replay with missing text sends `agent.output_lost`.
Outline lines expose reply timing and size through the number of deltas. They
also contain client-chosen ids, up to 200 characters for conversation and turn ids.
The execution marker remains unchanged and contains only turn ids.

After a restart or replacement, every started unfinished private turn fails,
even if it had not executed. Its thread died with the old process. Memory-free
prepared turns retry; executed turns fail. Private context is rebuilt by the
server after admission and never stored on the computer. Memory-free turns do
not receive it and cannot resume a former private thread.

Both configs switch shared prompt files and skill instructions off. Personal
and memory-free tools otherwise retain their existing persistent home and work.
No fallback is enabled without a failing pinned-image check. The live probe,
`test/private-turns.mjs`, runs after the existing image checks in `build.sh`.
[Check record](../../docs/process/p4-14-private-turns-evidence.md).
Memory admission remains disabled while swap, host crash dumps or the live proof
fail. This developer box cannot qualify swap or host core-dump isolation.
