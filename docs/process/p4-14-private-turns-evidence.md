# Private team turns check record

## 12 October qualification run

Branch: `work/p4-14-qual`, based on `origin/main`. The image build and live probe
ran under `nice -n 10` in separate throwaway namespaces. The provider used a local
model stub. No paid model call or owner stack was used.

| Check | Result | Detail |
| --- | --- | --- |
| Image build, licence and capability gates | PASS | 385/385 packages accepted; private capability check passed |
| Existing fresh and resumed image checks | PASS | gVisor runtime, desktop, documents, network and PVC checks passed |
| J1 | PASS | Replies and reasoning arrived; canary scans and private cleanup passed |
| J2 | PASS | Two private turns and one memory-free turn; held and released scans passed |
| J3 | PASS | Stop during a held reply; canary scans and private cleanup passed |
| J4 | FAIL | `SIGSEGV` was caught and did not exit Codex; forced cleanup then passed. The separate `SIGKILL` case passed |
| J5 | PASS | Reconnect during a held reply; one terminal report and cleanup passed |
| J6 | PASS | Bridge restart and replacement Pod lost pending output and did not repeat the turn |
| J7 | PASS | Tool attempts were refused; direct private compaction kept its canary in RAM and made no file |
| Canary scans | PASS | No canary reached the PVC, logs, shared notes, another member's prompt or provider request |
| Held-turn canaries | PASS | J2 found message, context and member canaries only in the private RAM volume and its turn home |
| Pod mounts | PASS | The private home used a separate memory-backed volume |
| Private volume mount | PASS | Node mount was `tmpfs`, 16 MiB, `noswap` |
| Private volume `statfs` | PASS | 16,777,216 bytes; the 16 MiB limit was enforced |
| Writable path census | PASS | Only `/tmp`, `/dev/shm` and private turn homes were writable |
| Guest core limits | PASS | Bridge and private Codex core size limits were both zero |
| runsc options | PASS | `io.containerd.runsc.v1`; no debug, trace or debug-log option was set |
| Private home peak | PASS | 2,923,663 bytes; symlinks are counted without following their targets |
| Private start time | PASS | 10 samples; p50 913 ms, p95 1,351 ms |
| Two-turn peak memory | PASS | 365,871,104 bytes at the Pod cgroup |
| F1: host swap | ACCEPTED (dev box, owner 12 Oct, [#366](https://github.com/elewa-git/opencrane-new/issues/366)) | `/swapfile` was active; no host setting was changed |
| F2: host apport dumps | ACCEPTED (dev box, owner 12 Oct, [#366](https://github.com/elewa-git/opencrane-new/issues/366)) | Host `core_pattern` uses apport; guest core limits passed |
| F3: complete live proof | FAIL | J4's `SIGSEGV` assertion failed; J5–J7 passed |
| Lint | PASS | Full repository lint, including docs, links and changelog |
| Typecheck | PASS | All workspaces |
| Event catalogue | PASS | 128 event types agree |
| Changelog lint | PASS | Unreleased fragment accepted |
| Changed computer tests | PASS | 6 tests passed |
| Full root suite | FAIL | First run: 4,151 passed, 6 failed, 18 skipped across 257 files |
| Affected-file recheck | PARTIAL | Four files passed (197 tests); `upgrade-after-publication` still found another database session |

F1 and F2 are accepted dev-box exceptions for the MVP and remain post-MVP
security gaps in [#366](https://github.com/elewa-git/opencrane-new/issues/366).
F3 is FAIL, so this run does not qualify private turns. The `SIGSEGV` check found
that the pinned Codex process catches signal 11 (`SigCgt` includes it) and keeps
running. The probe recorded the failure, sent `SIGKILL` to clean up that turn, and
continued. The separate `SIGKILL` case and J5–J7 passed. The probe namespace was
removed after capture. The JSON entry contains every check and raw measurement.
During J2, the probe found the expected active canaries in the private RAM volume
and one private home WAL file. It found none in the PVC, Pod logs, shared notes,
another member's prompt or provider request. The J7 tool attempts were refused and
the direct compaction canary appeared only in the allowed private RAM home.

The first root run's six failures were the live-view fixture's OpenFGA timeout, the
stale Codex path assertion, a provider-guard fixture's OpenFGA timeout, two handler
upgrade cases that found other database sessions, and the decision-fence test's
40-second timeout. The affected-file recheck passed the live-view, private Codex,
provider-guard and decision-fence files, plus two of the three upgrade recovery
cases. `upgrade-after-publication` still failed because a database session remained
open after the child was killed. The disposable database was removed after the
recheck. The root suite is not green.

Memory admission remains **DISABLED**. The live proof failed, and even after F3
passes with F1 and F2 accepted, the unauthenticated `/credentials` route remains
the separate blocker tracked in [#200](https://github.com/elewa-git/opencrane-new/issues/200).
The setting in `apps/server/src/chat/memory-admission.ts` stays disabled for those
two reasons.

The JSON beside this record contains the probe results and measurements from this
run. It records F1 and F2 with the owner-approved status and records F3 as FAIL.
J5–J7 passed after the probe cleaned up the turn that caught `SIGSEGV`.

## 5 October source and test record

The earlier source record follows. Its live probe, host-risk and registry details
were superseded by the 12 October run above.

## Behaviour and limits

Default team turns use a new tool-free process and ephemeral thread. Memory-free
and personal turns retain their persistent threads. Private context contains only
the requester's earlier completed exchanges, capped at 24 KiB. Unfinished exchanges
contain times but no request text. History is read after admission, outside the
two-second check of the small access streams.

A failed private context read refuses that turn, returns no token or context and
closes the turn as failed. Other members keep their bridge connection. Private
text reports remain in bridge memory until acknowledged. Their disk records omit
text; replay after text is lost sends `agent.output_lost`. Started unfinished
private turns fail after restart and never repeat.

The local capability check failed before the home fix: `private.sock` closed before
initialisation. It passes after removing chmod following chown. Memory-free start
reports omit `executionMode`, both on the socket and in the journal. The added test
failed before that change. The context failure test also fails before its fix.
The long-context test uses 400 rows and retains its access and append order checks.

All private turns share UID 1003. The kernel does not separate their homes or
processes. UID 1003 can read the workspace and reach loopback ports 8080, 8081 and
6901. It can write `/tmp` on node disk, `/dev/shm` and world-writable workspace
folders. Directory protections and the writable path census are not yet checked
under gVisor. Every UID 1000 process can reach `private.sock`.

Socket closure ends private input. The supervisor tries to kill a remaining
process after five seconds, checks failure and retries twice. Failed attempts log
one fixed line without member text. Cleanup within five seconds and home removal
are not yet proven under gVisor; J4 and J6 remain NOT RUN.

Loopback `POST /credentials` currently accepts an unauthenticated replacement.
Local desktop or memory-free Codex processes can take over `/bridge`, read private
reports waiting in memory and forge context acknowledgements. This must be fixed
before private tools or memory are enabled. The hardening work is [#200](https://github.com/elewa-git/opencrane-new/issues/200).
Private files, bridge memory and supervisor buffers are swappable here. The private
home's actual gVisor backing has not been measured. The PVC deliberately retains
memory-free content and private outline ids, timing and counts.

Shared prompt files and skill instructions are off in personal and memory-free
turns as well as private turns. This behaviour has its own changelog entry.

## Image publication

`build.sh` normally pushes to `127.0.0.1:5001`, the published port of
`k3d-ocn-registry`. Its Docker proxy forwards to `172.17.0.3:5000`, which returns
“No route to host”. The published port accepts TCP and then resets the connection;
requests do not reach the registry. The host route selects `docker0`, but the
neighbour entry for `172.17.0.3` is FAILED. Both addresses are still present
inside the registry container. Repairing that host network path is outside the
allowed changes. The same registry responds with HTTP 200 at
`172.18.0.2:5000` on the `k3d-ocn` network and inside its container.

A temporary user-space TCP forwarder on `127.0.0.1:15001` connects to that working
address. A diagnostic push through it passed. `COMPUTER_PUSH_REGISTRY` lets the
build use this address while Pod references keep `k3d-ocn-registry:5000`.
No Docker settings, iptables, bridges or routes are changed. No stack is restarted.
The final build passed. Both tags publish
`sha256:94d4dbc8d3fb45f6dc0a23aac9a15dc5ade0cbfa49c8d2bef3015eba15db8032`.
The template pins that digest. Fresh and resumed image checks pass under gVisor;
the separate private J1–J7 journeys remain NOT RUN.

## Rollout

The image must be built, published and pinned before merge. An unpublished image
blocks merge because the old image refuses default team turns on the new server.

1. Publish the image and pin its digest in `sandbox-template.json`.
2. Regenerate each silo's policy from the new template with
   `node infra/dev-stack/computer-admission.mjs <NAMESPACE>`.
3. Deploy the new server.
4. Replace running team computers through the normal suspend/resume lifecycle.

Between steps 3 and 4, default private team turns fail on old computers. Personal
and memory-free turns continue. New computers need the new admission policy.
Memory-free start reports now work on older servers. Restricted reports still
require the new server: pause team traffic and finish private turns before a server
rollback; use only memory-free team turns until restricted reports are supported.
The [computer contract](../../apps/computer/README.robot.md#private-turn-rollout)
records the same order and rollback limits.

## Scope and earlier runs

The canary probe, provider and build wiring move to `work/p4-14-qualification`,
based on this branch. Its driver and scanner are separate readable `.mjs` files.
That branch is pushed without a PR. This split follows the latest #96 decision.
The remaining diff is about 3,000 added/removed lines, including the new local
capability fixture. It still exceeds the approximately 1,800-line allowance.
The required product and regression tests remain together; no size approval is
claimed. Final non-generated counts against `origin/main` are:

| Area | Added and removed lines |
| --- | --- |
| Product | 1,223 |
| Regression tests and local capability fixture | 1,346 |
| Documentation and check records | 443 |
| Total | 3,012 |

The earlier receipt wrongly attributed an instruction to the owner. The instruction
to include every listed check came from the supplied spec. The owner allowed about
300 lines over 1,500, and the orchestrator later chose the split.

Earlier runs, before these fixes:

- Three private suites: PASS, 65 tests. Required source checks: PASS.
- Before the dispatch fixture adjustment: FAIL, 65 passed and two dispatch failures.
  The watcher needed the projection runner's checkpoint table after rebase. The
  two cases now pass with the normal runner initialisation; no deadline is raised.
- First root start during these fixes: PARTIAL, stopped to correct that fixture.
  It started at load 11.78. The current results show the subsequent complete run.
- Focused run: FAIL, 163 passed and two long-session failures.
- Root run: FAIL, 1,883 passed, 11 failed and 15 skipped under rising host load.
- Local Docker image and licence checks: PASS. Publication through port 5001: FAIL.
- Private gVisor journeys and fresh-install qualification: NOT RUN.

Chat screens, memory injection, per-Pod report sequences and managed-node
qualification remain outside this change. The owner accepted host swap and
apport handling on this dev box for the MVP; [#366](https://github.com/elewa-git/opencrane-new/issues/366)
tracks both as post-MVP gaps. Memory admission stays disabled until the live proof
passes and the unauthenticated `/credentials` route is fixed in
[#200](https://github.com/elewa-git/opencrane-new/issues/200).
