# Private team turns check record

Date: 5 October 2026. Source branch: `work/p4-14-private-turns` at `d440eda`.
Source draft PR: [#197](https://github.com/elewa-git/opencrane-new/pull/197).
Base: `913e6cf`. The rebase completed and main's dispatch retry is preserved.

The qualification scripts are on `work/p4-14-qualification`, based on the source
fixes. This branch has no PR. Syntax checks and the standalone scanner fixture pass.
The complete driver, image build with the restored probe and J1–J7 remain NOT RUN.
The source and image checks below apply to `d440eda`; they do not qualify this probe.

## Current results

These rows describe the final fixes. Earlier runs are listed separately below.
All suites and builds run under `nice -n 10`. Service tests use disposable fixtures
and `PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`, with two workers.
No paid model call or owner stack is used.

| Check | Result | Detail |
| --- | --- | --- |
| Lint | PASS | Code, dependencies, unused code, Markdown, links and fixtures |
| Typecheck | PASS | All workspaces |
| Event catalogue | PASS | 96 event types agree |
| private-context | PASS | 6 tests |
| private-codex | PASS | 5 tests |
| private-turn-channel | PASS | 55 tests, including mode omission |
| shared-assistant | PASS | 27 tests, including both dispatch modes and context failure |
| shared-runtime | PASS | 1 test |
| bridge-channel | PASS | 11 tests |
| bridge-replay | PASS | 12 tests |
| chat | PASS | 8 tests |
| chat-http | PASS | 1 test |
| upload | PASS | 7 tests |
| Full root suite | FAIL | 1,918 passed, 1 failed, 15 skipped; start load 11.62 |
| Gateway settlement recheck | PASS | Failed root case passes alone; root failure remains recorded |
| Local capability check | PASS | Private socket, pinned Codex, exact template capabilities, stub provider |
| Image build and publication | PASS | 384 licences, 91 notices; qualification and release tags published |
| Existing gVisor image checks | PASS | Custom host, fresh image and retained-disk resume |
| Private gVisor journeys J1–J7 | NOT RUN | Probe moved to qualification branch |
| F1: swap | FAIL | `/swapfile` is active; private process and memory-volume pages can reach disk |
| F2: crash dumps | FAIL | Host `core_pattern` sends dumps to apport; guest limit is checked separately |
| F3: complete live proof | NOT RUN | Needs all private gVisor journeys and measurements |

The capability remains **PARTIAL**. Memory admission remains **DISABLED**.
Disk isolation is not yet proven on a live computer; memory features stay off
until it is. The JSON beside this record contains only private-probe status and
measurements. It does not contain source checks and is not a completed probe run.
The complete root run has one failure: the gateway test “leaves money reserved on
settlement failure and retries the recorded effect idempotently” exceeded 40 seconds.
No timeout is raised. The case passes alone in the isolated recheck. The complete
run remains FAIL; this draft is not source ready.
Logs for these fixes are under `/tmp/p414-fixes/` on the builder host.

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
claimed. The primary PR's final non-generated counts against `origin/main` are:

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
qualification remain outside this change. Memory admission stays disabled until
swap, crash-dump handling and the complete live proof pass on a qualified node.
