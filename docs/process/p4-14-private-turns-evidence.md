# Private team turns check record

## 12 October qualification after fixes

**PASS for J1–J7 on the dev box**, with only F1 and F2 accepted by the owner on
12 October. **Memory admission stays DISABLED.** This run qualifies the process
and storage checks below. It does not execute Codex's own memory-fault handler or
qualify memory tools and memory-derived replies.

The branch was rebased onto `origin/main` at `580a07f6`; the rebase finished and
that commit is an ancestor. The probe source is `7310240f11ca5c8c96aad00ce18865d8117d40eb`.
The image is `k3d-ocn-registry:5000/opencrane/computer@sha256:3bb44be151ce4b91c8dcadcf6b78a3bd1bc8e09f7ec93a423e25543e6007735a`. The fresh namespace was `p414-private-eb6a63d8`
and was deleted after the run. Commands used `nice -n 10`. The local provider was
a fixture: no paid model call, dev-stack slot or owner stack was used. Host
settings were unchanged.

| Check | Result | Observed result |
| --- | --- | --- |
| Image build, contents, licences and capabilities | PASS | Product source matched the checkout; fault helpers and fixtures were absent from the image |
| Fresh and resumed image checks | PASS | gVisor, desktop, documents, network, hostile PVC cases and resume passed |
| J1 | PASS | Replies and reasoning arrived; private cleanup and canary scans passed |
| J2 | PASS | Two private turns ran beside a memory-free turn; member context stayed separate |
| J3 | PASS | Stop produced one failed terminal report, bounded removal, no repeat and no canary on the PVC |
| J4 | PASS | Real native fault died of SIGSEGV; pinned Codex SIGKILL passed failed-report, cleanup and no-repeat checks |
| J5 | PASS | Reconnect retained one terminal report and cleaned up the private turn |
| J6 | PASS | Bridge restart and replacement Pod lost pending output and did not repeat work |
| J7 | PASS | Tool attempts were refused; compaction kept its canary in RAM and created no tool file |
| Canary scans | PASS | No private canary on the PVC, in Pod logs, shared notes or another member's model input |
| Writable guest paths | PASS | Full directory and regular-file census; writable stored files were under `/tmp`, `/dev/shm` and private homes |
| RAM home and core limits | PASS | Separate 16 MiB tmpfs; bridge and private Codex soft/hard core limits were 0/0 |
| Native helper conditions | PASS | Same Pod/runtime, UID/GID 1003, groups, capabilities, no-new-privileges, core limits, environment and RAM working directory |
| Dump inventories | PASS | Every writable guest path and relevant host/node dump and log locations checked before and after; no new or changed core/dump |
| Private home peak | PASS | Largest sampled home: 2,903,063 bytes |
| Private start time | PASS | Ten samples; p50 848 ms, p95 956 ms |
| F1: host swap | ACCEPTED | Dev-box MVP exception in [#366](https://github.com/elewa-git/opencrane-new/issues/366) |
| F2: host crash dumps | ACCEPTED | Same owner decision; guest 0/0 core limits remain required |
| F3: required live checks | PASS | Every required check and measurement passed; probe exit status was zero |
| Codex's own memory-fault path | NOT RUN | Source inspected; the native helper does not execute Codex's handler |
| Lint, typecheck, event catalogue, knip and changelog lint | PASS | 130 event types agree; lint had warnings and no errors |
| Changed tests | PASS | 27 tests passed twice with `PG_TEST_URL` set; one worker |
| Local full root suite | NOT RUN | Excluded from this fix's requested checks |

The [JSON record](evidence/p4-14/private-turns.json) contains the checks, process
conditions, timings and paths. Its [compressed JSON inventories](evidence/p4-14/private-turns-inventories.json.gz)
retain all file entries, sizes, inode numbers, modification times, hashes and dump
flags. The record includes the archive's SHA-256 checksum. No file was omitted to
reduce the record's size. `139` guest files and
`22489` host/node files were inventoried before the fault.
The writable census excludes process/kernel interfaces and devices other than
`/dev/shm`; these exclusions are explicit in the record.

## What the memory fault proves

The native helper reads a canary into memory, maps a page with `PROT_NONE` (no
read or write access), and writes to it. The parent observed fatal `SIGSEGV`.
The helper inherited the same measured conditions as the held private Codex turn.
The inventories reject newly created or changed named core/dump files, ELF core
files and minidumps, even if they contain no canary. Existing dump files were
recorded before the fault. The guest does not expose `core_pattern`; the host
pattern and both guest core limits are recorded separately.

The pinned Codex binary is version 0.159.2, SHA-256
`1748767b230ebfc3d4ab7e4e254920d0c0ad9691fd8c11f190e7d44511a4a92e`.
Its embedded Rust source paths identify commit `59807616e1fa2540724bfbac14d7976d7e4a3860`.
The [matching Rust handler](https://github.com/rust-lang/rust/blob/59807616e1fa2540724bfbac14d7976d7e4a3860/library/std/src/sys/pal/unix/stack_overflow.rs#L101-L143)
checks the thread's stack guard. A stack overflow prints a diagnostic and aborts.
For another fault, it restores the default handler and returns; a real invalid
memory access then faults again. An external signal has no instruction to repeat.
The [Codex source tag](https://github.com/openai/codex/tree/8b9fa496bbf2c47aebd62e85a080b9a522a455b5)
selects Rust 1.95.0 and has no explicit SIGSEGV handler in its Rust sources.
The earlier after-signal mask, `0x4040`, no longer contained the SIGSEGV bit.
That observation is consistent with this handler removing itself.

This identifies the expected standard-library handler from source and binary
paths. It does not establish the active handler address or execute Codex's own
stack-overflow or other memory-fault path. Those paths remain unqualified.
The pinned binary's SIGKILL and Stop paths were exercised separately.

## Fixes and failing-first checks

Agent-UID tests first reproduced the X11 symlink disclosure, symlink and
foreign-owner locks, and replacement during unlink. Startup now makes root-owned
`/tmp` sticky before children start. Directory and lock operations use checked
non-following descriptors, owner/type checks and an inode comparison before
removal. The sticky parent prevents an untrusted user replacing that checked lock.

Exit-status tests first showed required failures and infrastructure errors could
return zero. Every required FAIL or NOT RUN now prevents promotion. Only the
named F1/F2 host exceptions are accepted. Unreadable canary scans also fail.
Shutdown tests first reproduced open-connection and interrupted-shell leaks,
including interruption during a check that reads standard input. TERM and INT
now stop the build and its bounded registry listener, destroying open sockets.
Each failing test change was committed before its fix.

Earlier live attempts stopped on three fixture issues: an oversized apply
annotation, the absent guest `core_pattern` file, and the normal gap between old
and replacement Pods. The JSON records those failures. Required assertions were
retained. The final complete build passed and promoted the checked image.

## Memory stays disabled

Passing these checks does not enable memory. The unauthenticated `/credentials`
route remains tracked in [#200](https://github.com/elewa-git/opencrane-new/issues/200)
and [PR #371](https://github.com/elewa-git/opencrane-new/pull/371).
The [accepted design](https://github.com/elewa-git/opencrane-new/pull/326) also needs
volatile memory-derived output, invalidation and qualified memory-tool journeys.
`apps/server/src/chat/reports.ts` still encrypts reply text with conversation keys.
`memory-admission.ts` remains disabled; no access, money or memory check was relaxed.

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
