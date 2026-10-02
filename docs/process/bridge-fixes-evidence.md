# P2-3 review fixes — 2 October 2026

Source: `work/bridge`, parent `8185782`, correcting the bridge in `d024a38`.
This receipt belongs to the commit containing these fixes. Review pass 1 was
**FIX THEN LAND**. Pass 2 has not run; this change is committed locally, not landed.
The model registry, prices and routing table from `8185782` are unchanged.
No new dependency was added. The signed turn grant now includes `thread` and
`task` alongside conversation and requester; the following model-routing fixer
can bind its decision to that `task` claim.

## Reproductions and fixes

Each numbered blocker was reproduced with a failing test before its fix.

| Finding | Observed failure | Fix and passing regression |
| --- | --- | --- |
| 1. Report restores admission | Forged restart after completion/failure returned HTTP 200 | Admission reads server-owned `computer.turn_started` / `computer.turn_closed` only. Both terminal cases return 403, with zero reservations and zero provider calls in the real gateway test. An additional test closes a turn before admission and refuses later start. |
| 2. Grant crosses threads | Valid token bound to `thread`, presented as `conversation`, returned 200 | Signed thread must equal the request's actual `session-id`; signed conversation, requester and task must match server admission. The real local proxy test installs the token under another thread with a false conversation identity: 403 and zero reservations; the proper thread succeeds. |
| 3. Suspend swallows message | Replacing the bridge after its start report emitted `agent.turn_failed` | Admission and idle suspension contend on the computer stream. Prepared starts lack an execution marker and retry with a fresh grant. Deterministic NATS positions are scan head 3, message 4, start report 5, suspend 6. After replacement the message executes once; duplicates do not re-execute it and no failure is reported. |
| 4. Reconnect keeps old grant | After a 121-second clock advance, the pending message never executed | A start needs its own acknowledgement carrying a fresh grant. Reconnect replays pending starts even below the durable checkpoint. The test executes once using the refreshed grant. |
| 5. Unbounded, shared queue | A stalled thread prevented another thread's acknowledgement | Separate ordered queues per conversation thread: 64 reports and 1 MiB each, including in-flight persistence, at most 64 queues per socket. Count and byte tests independently exceed the bound, close with 1013 / `Report queue limit`, and prove another thread acknowledges while persistence is stalled. |
| 6. Conflicting reports both succeed | A barrier at the real NATS append boundary produced two successful results for different payloads | Compare the committed digest after append and on retry. Exactly one concurrent payload succeeds; stored text matches that winner and the losing retry is refused. |

Creation stores immutable mode in `conversation.created`. Omitted API mode
defaults to `agent_session`; Phase 2 refuses `direct` and `group` with HTTP 400
and a clear message. Command retries cannot change mode. Real PostgreSQL
projection rebuild retains it; the HTTP list includes it.

Report persistence and server turn lifecycle are separate commands, each with
one conditional append to one stream. The watcher recovers a crash between a
terminal report and its lifecycle closure. Once admitted, a turn prevents idle
suspend. If suspend wins first, the unexecuted message is delivered after wake.
The PVC execution marker is written before Codex invocation; ambiguous execution
remains failed, never automatically repeated. Older journals without the new
preparation distinction also remain uncertain.

## Gates

The PostgreSQL test fixture is the separate `pg-test` instance on port 55432;
NATS and OpenFGA use disposable fixtures. No shared dev-stack process, database,
namespace, ownership marker or deployment was changed.

| Command | Result |
| --- | --- |
| `npm run lint` | PASS; five function-size warnings, no errors |
| `npm run typecheck` | PASS |
| `npm run check:events` | PASS, 73 event types |
| `PG_TEST_URL=… npm test` | PASS, 1,008 passed / 3 skipped; 140.74 seconds |
| `npm run build -w apps/web` | PASS; existing CSS size warning |
| `npm run test -w apps/web` | PASS, 41 tests |
| `BRIDGE_SUSPEND_K3D=1 npx vitest run apps/server/test/bridge-suspend.test.ts` | PASS, local and k3d variants; 24.22 seconds |

The opt-in test creates a private namespace, fresh gVisor Pod and PVC, builds
only the current bridge source and its existing dependencies, then deletes and
replaces the Pod against the same PVC. Its Codex RPC boundary is a durable
execution counter. This proves the suspend race and bridge recovery on real
Kubernetes; it does not qualify a full Codex/provider journey. The namespace and
PVC are removed afterwards. An initial harness attempt used port-forward, which
could not reach the gVisor listener; the corrected test uses Kubernetes Pod proxy.

## NOT RUN

- Independent review pass 2 and merge/CI on main.
- The original `BRIDGE_K3D` shared-stack journey and `LIFECYCLE_K3D` suite.
- Fresh full-product install with real Codex, OIDC and provider replies on these fixes.
- Production computer image build/licence qualification, paid model calls and cloud qualification.
- Upgrade/replay qualification against a pre-fix populated silo.

The ordinary suite still skips the two existing opt-in k3d journeys and paid
model test. Source gates do not claim the full capability is live-qualified.
