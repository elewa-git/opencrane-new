# Wake latency evidence — 3 October 2026

**PASS for the stub wake latency budget after repair:** five repeated runs.
Median `message.posted` → first Codex token was **9.120 s**, spread
**8.981–10.597 s**. The original optimised median was **8.944 s**; the repair
batch is 0.176 s higher (2.0%), and 20.4% below the original **11.462 s** baseline.
The median remains faster than the owner's accepted 10–14 s target.
Real-provider latency is **NOT RUN**.

## Missing-resource repair

Follow-up base: `ebd0891`, on the same branch. The reviewer's deletion
reproduction failed first for both `computer.ready` and `computer.resumed`:
`kube.mode()` raised NotFound and terminated the watcher. The watcher now
checks Sandbox and claim presence in one kubectl process, follows
`computer.lost` when either binding is missing, and lets the existing loss
reaction re-claim with a new generation and token id. Healthy Ready and Resumed
computers still skip `claim()`; the state read adds one claim HTTP lookup, with
no additional kubectl process or PVC read on that path.

Normal cascading deletion also removes the Sandbox-owned PVC. Those cases
must record loss and recover with generation 2. Separate orphan-deletion cases
retain the PVC, remove the old Pod, and assert the same PVC UID and preserved
workspace file after recovery. Deleting only the claim exposed the controller's
refusal to adopt an orphaned Sandbox; claim reconciliation now checks computer
and assistant labels and repairs ownership to the recreated same-name claim,
using the Sandbox resource version to reject races. Admission permits that
ownership repair while retaining the existing Pod, label and configuration
restrictions. Other claim names and owner kinds remain denied. These policies
were installed only in disposable test namespaces; the shared dev stack was
not changed.

The surviving old Ready Pod must also be fenced after re-claim. A further live
regression first failed by reusing its Pod UID; `computer.claimed` now uses the
same old-Pod suspend fence as `computer.resumed` before delivering credentials.
Per-computer reconciliation errors are logged and retried on the next poll.
The state- and mode-error regressions first failed with NotFound, then passed
with both NotFound and transient errors on one computer while another receives
credentials across repeated polls.

### Repeated five-run measurement and final checks

The unchanged runner used the same pinned base image, stub, probe settings,
conversation, suspension method and cached layers. It ran after the full suite
and live checks finished, in namespace `wake-latency-0a292b91`, which was deleted.
The new timestamp-only derivative's digest is recorded beside the new samples;
the pinned computer base and computer source are unchanged.
The dev host and cluster were reused; host load was not controlled. These five
samples do not establish the cause of the small median difference or a tail
latency guarantee. Real-provider and fresh full-install qualification remain
**NOT RUN**.

The raw receipt retains every original batch. The new `repair` sample/image
entries and `repairSourceBlobs` identify this follow-up's measured code; the
runner logged its parent `ebd0891` while the working-tree repair was present.

| Stage | Original after: median (min–max), s | Repair: median (min–max), s |
| --- | --- | --- |
| message.posted → resume intent | 0.420 (0.173–0.574) | 0.394 (0.156–0.412) |
| Resume intent → Running patch acknowledged | 1.221 (0.724–1.338) | 0.897 (0.682–1.157) |
| Running acknowledgement → Pod scheduled | 0.015 (-0.013–0.899) | 0.024 (0.012–0.508) |
| Pod scheduled → image ready | 0.709 (0.619–0.813) | 0.674 (0.617–0.822) |
| Image ready → image/volume ready | 0.045 (0.023–0.071) | 0.039 (0.033–0.064) |
| Image/volume ready → container started | 0.279 (0.260–0.330) | 0.328 (0.310–0.359) |
| Container started → computer HTTP listening | 1.205 (1.033–1.609) | 1.638 (1.150–1.884) |
| Computer HTTP listening → Codex initialised | 0.940 (0.464–1.191) | 0.797 (0.562–1.690) |
| Codex initialised → computer health ready | 0.609 (0.027–0.965) | 0.355 (0.176–0.774) |
| Computer health ready → Pod Ready | 0.027 (0.022–0.049) | 0.030 (0.025–0.041) |
| Pod Ready → credential delivered | 0.828 (0.530–1.661) | 1.299 (1.209–1.513) |
| Credential delivered → WebSocket connected | 0.434 (0.317–0.696) | 0.411 (0.277–0.662) |
| WebSocket connected → turn/start | 1.714 (1.276–2.102) | 1.814 (1.570–2.163) |
| turn/start → first token | 0.473 (0.399–0.690) | 0.506 (0.414–0.875) |
| First token → committed delta | 0.096 (0.064–0.140) | 0.085 (0.039–0.126) |
| **Wake → first token** | 8.944 (7.816–10.079) | 9.120 (8.981–10.597) |

| Run | Repair wake → first token, s |
| --- | --- |
| 1 | 10.190 |
| 2 | 9.120 |
| 3 | 10.597 |
| 4 | 8.981 |
| 5 | 9.059 |

| Command / qualification | Follow-up result |
| --- | --- |
| `npm run lint` | PASS; five existing function-length warnings |
| `npm run typecheck` | PASS; all workspaces |
| `npm run check:events` | PASS; 73 event types |
| `PG_TEST_URL=… npm test -- --maxWorkers=2` | PASS; 1,021 passed, 10 opt-in skips; 390.24 s |
| Watcher fast-path and error regressions | PASS; three tests; 10.84 s; also passed in the final suite |
| Live lifecycle batch with worker RBAC/admission | PASS; seven tests; 432.17 s |
| Final claim-only fence regressions, Ready and Resumed | PASS; two tests; 112.33 s; cover the new re-claim fence |
| Unchanged five-run wake runner | PASS; five suspended wakes in the same conversation |
| `tsc --noEmit -p infra/dev-stack/tsconfig.json` | PASS |
| Namespace and admission-policy cleanup | PASS; no test namespaces or admission policies remain |
| Independent verification of this follow-up | NOT RUN |

The first full suite run was **FAIL**: the existing authorisation test
`cleans a rebuild store when the create response is lost at the HTTP boundary`
hit its five-second budget; 1,020 tests passed, nine skipped, 392.58 s. It passed
when rerun alone (10.03 s for the invocation), without code or timeout changes.
The final full suite then passed as recorded above.

The original two deletion regressions failed with NotFound before the fix.
An intermediate direct-repair attempt recovered computers but failed the PVC
UID assertions after normal cascading deletion; it was replaced by the explicit
loss path. The claim-only test then exposed failed Sandbox adoption. A
Sandbox-only absence assertion also raced with successful controller repair;
the final test accepts that recovery and still checks the retained disk and
replacement Pod. Every failed fixture namespace was deleted.

All eight distinct live scenarios passed across the seven-test batch and the
focused fence rerun: both resources missing at Ready and Resumed, normal and
retained-disk deletion, claim-only loss at Ready and Resumed, Sandbox-only loss
at Resumed, and the original full lifecycle journey. The final fence rerun
requires a new Pod UID after claim-only loss at both Ready and Resumed.
Only disposable namespaces and their own admission policies were changed.
No dependency or licence changed, no real provider was called, and nothing was
pushed. Reproduce the new batch with the existing runner label `after-repair`.

## Original source and environment

Base: `113854436bc4b4caaae595ac222b5c45d5834cd3`, branch `work/wake-latency`.
After means the original lifecycle and bridge changes in `ebd0891`; exact
source blobs, image digests and timestamp samples are in the
[raw receipt](wake-latency-samples.json).

Developer box, Node 22.23.3, npm 12.2.0, existing `k3d-ocn`, gVisor and
local-path PVCs. Each batch had a new disposable namespace, NATS server and
PostgreSQL database on the separate test instance at port 55432. The host and
cluster were reused, and the shared dev stack continued running. The first
computer claim warmed the image and created the PVC before timing started.
Each of five measured messages followed event-backed suspension and confirmed
old-Pod removal, reusing the disk and conversation. No namespace, service,
ownership marker or configuration in the shared dev stack was changed.

Namespaces: `wake-latency-fc428de8` (before), `wake-latency-f9de039f`
(claim-only experiment), `wake-latency-ddea6582` (before the lint-only bookkeeping change),
and `wake-latency-08a9aecb` (final after). All were deleted.

The pinned computer base was unchanged:

```text
k3d-ocn-registry:5000/opencrane/computer@sha256:afb9835f5ed42662307e4826f76efd47abb02a23d86180af877b8a11947b0597
```

The harness built timestamp-only derivatives of that image; it did not replace
the production template's image. Real Codex, desktop, executor, proxy, bridge,
NATS appends, conversation projection, computer credentials and turn-grant
issuance ran. The model HTTP boundary was a stub Pod in the same namespace,
with no provider credentials or forwarding code. The computer's existing
network policy allowed only that labelled gateway on port 3000. Model admission,
agentgateway, OIDC and browser delivery were outside this measurement.
**No real OpenAI call was made.** No dependency or licence changed.

## Original method and stage measurements

[The runner](../../infra/dev-stack/wake-latency.ts) uses the public chat command,
`watchBridges`, `watchComputers` and `suspendComputer`. Commands still append
intent before effects. It waits for each stored terminal report and lifecycle
turn closure before suspending for the next sample. Both batches used the same
five-turn method, probe settings, base image, stub and instrumentation.

Times below are differences between adjacent observed markers, in seconds.
Spread means minimum to maximum, not a confidence interval. Event timestamps
mark message/resume intent creation just before their conditional appends.
Kubernetes watches mark scheduling, `Pulled`, `Created` and `Started` arrival;
`Created` is the combined image/volume-ready boundary. Container-local markers
use `Date.now()` for HTTP listening, Codex's initialise response, successful
health response, authenticated WebSocket connection, sending `turn/start`, and
the first `item/agentMessage/delta`. All share the dev host's clock.

Codex starts in parallel with the desktop and is initialised **before**
credentials and the WebSocket, so its cost is shown at its actual place in the
path. Computer HTTP listening is distinct from a passing health probe. The
credential-to-WebSocket stage includes the server's fresh, forced credential
delivery on reconnect; it remains serial because the handshake authenticates
against the delivered token. Image layers were cached on every measured wake.

Small negative scheduling observations (−0.009 s before, −0.013 s after) mean the Pod watch arrived before kubectl
returned its Running-patch acknowledgement; it is an observation race, not
negative work. Watch stages include delivery lag, not just Kubernetes execution.
Independent focused tests briefly overlapped the final batch; host load was
not controlled. Five samples on a busy dev host do not establish a tail-latency guarantee.

| Stage | Before: median (min–max), s | After: median (min–max), s |
| --- | --- | --- |
| message.posted → resume intent | 0.697 (0.122–1.399) | 0.420 (0.173–0.574) |
| Resume intent → Running patch acknowledged | 1.636 (1.183–2.151) | 1.221 (0.724–1.338) |
| Running acknowledgement → Pod scheduled | 0.028 (-0.009–0.940) | 0.015 (-0.013–0.899) |
| Pod scheduled → image ready | 0.676 (0.604–0.728) | 0.709 (0.619–0.813) |
| Image ready → image/volume ready | 0.046 (0.042–0.051) | 0.045 (0.023–0.071) |
| Image/volume ready → container started | 0.322 (0.269–0.535) | 0.279 (0.260–0.330) |
| Container started → computer HTTP listening | 1.321 (1.189–2.284) | 1.205 (1.033–1.609) |
| Computer HTTP listening → Codex initialised | 0.861 (0.651–0.936) | 0.940 (0.464–1.191) |
| Codex initialised → computer health ready | 0.555 (0.083–0.891) | 0.609 (0.027–0.965) |
| Computer health ready → Pod Ready | 0.029 (0.028–0.034) | 0.027 (0.022–0.049) |
| Pod Ready → credential delivered | 1.592 (1.459–1.687) | 0.828 (0.530–1.661) |
| Credential delivered → WebSocket connected | 1.102 (0.206–1.641) | 0.434 (0.317–0.696) |
| WebSocket connected → turn/start | 1.902 (1.183–2.258) | 1.714 (1.276–2.102) |
| turn/start → first token | 0.496 (0.401–0.625) | 0.473 (0.399–0.690) |
| First token → committed delta | 0.122 (0.029–0.236) | 0.096 (0.064–0.140) |
| **Wake → first token** | 11.462 (9.433–13.316) | 8.944 (7.816–10.079) |

| Run | Before wake → token, s | After wake → token, s |
| --- | --- | --- |
| 1 | 9.743 | 7.816 |
| 2 | 9.433 | 9.636 |
| 3 | 11.462 | 8.944 |
| 4 | 13.182 | 8.728 |
| 5 | 13.316 | 10.079 |

## Changes and test-first evidence

1. The original optimisation reconciled a claim only for `computer.claimed`.
   The repair above checks that Resumed and Ready bindings still exist before
   skipping reconciliation. The original change removed four serial kubectl
   reads per reconciliation: claim twice, Sandbox and PVC. State observation,
   the old-Pod suspend fence, Running patch and delivery-before-Ready ordering
   remain. The regression first failed with `Claim endpoint unavailable`, then
   passed: a bound computer resumes despite that endpoint being unavailable,
   while the old Pod is fenced before its replacement receives credentials.
2. Read recorded `computer.turn_closed` ids while reading current lifecycle
   state, and skip terminal recovery for those ids. Missing closures still run
   the same conditional command. No process-local completion cache or new truth
   was added. The regression first timed out waiting for the next conversation's
   message, then passed: a stalled extra archive read for an already closed turn
   cannot hold up another conversation's wake.

The claim-only batch had median **10.387 s**, spread **7.874–16.762 s**. It
exposed growing terminal-recovery work across successive turns; all five samples
are retained in the raw receipt. Final recovery no longer repeats closed-turn
commands on every poll. The five-run pre-lint batch was **9.482 s** (8.100–10.789 s). The final batch
repeats measurement after reusing the existing history helper to meet the
complexity limit; both intermediate batches remain in the raw receipt.
Native Codex thread preparation and process startup
remain measured costs. Polls are still 250 ms and the readiness probe period is
already 1 s. A watch/proxy rewrite, changed readiness meaning, a new image,
credential-handshake overlap and keeping suspended processes alive were not
needed for this measured budget.

## Original checks and safety qualification

| Command / qualification | Result |
| --- | --- |
| `npm ci` | PASS; 877 packages, no dependency change |
| `npm run lint` | PASS; five existing function-length warnings, no errors |
| `npm run typecheck` | PASS |
| `npm run check:events` | PASS; 73 event types |
| `PG_TEST_URL=… npm test -- --maxWorkers=2` | PASS; 1,019 passed, three opt-in skips; 364.63 s |
| Two changed regression files, `vitest run … --maxWorkers=1` | PASS; seven tests; 18.17 s |
| `LIFECYCLE_K3D=1 PG_TEST_URL=… vitest run apps/ops/test/lifecycle-k3d.test.ts` | PASS; one live test; 110.71 s |
| `tsc --noEmit -p infra/dev-stack/tsconfig.json` | PASS |
| Runner context/namespace-collision guards | PASS; fake kubectl confirmed no deletion on either refusal |
| Original independent review, passes 1 and 2 | Originally reported PASS; superseded by the reproduced missing-resource blocker above |

The first full `npm test` run overlapped lint, typecheck and the live lifecycle
qualification: **FAIL**, two existing five-second bridge tests timed out;
1,017 passed, three skipped, 200.94 s. Both failed tests passed in the isolated
seven-test run above without behaviour fixes. The whole suite then passed with
two workers. No timeout was increased. The reviewer's two runs without
`PG_TEST_URL` also hit the five-second budgets in three bridge tests, including
the new archive regression; those default Docker-fixture failures are retained
as **FAIL**, not reclassified as passing. Required final checks and isolation
used the requested external PostgreSQL test instance.

Initial lint found the bridge callback above the complexity limit and a test
throwing an unknown value. Reusing the existing full-history helper kept the
same recovery behaviour within the limit; the test now throws only an Error.
Final source hashes and the repeated after measurements match that code.

The regression seams are the existing public lifecycle watcher and bridge
watcher/protocol boundaries. Kubernetes and NATS stalls are injected at external
adapters; durable Ready/closure events and delivery of the next message are the
outcomes. Existing token, replay, refusal and suspend-race tests remain enabled.
The live lifecycle test uses a separate disposable namespace with admission and
worker RBAC, and checks fresh claim, failed intent append, restart recovery,
readiness flap, old-Pod fence, token rotation, Pod-UID loss, replacement disk
retention, projection replay and forbidden Kubernetes operations.

Reproduce after a local `npm ci` and the root pretest tool fetch:

```sh
export PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres
node --experimental-strip-types infra/dev-stack/wake-latency.ts after-repair
LIFECYCLE_K3D=1 npx vitest run apps/ops/test/lifecycle-k3d.test.ts
npm run lint
npm run typecheck
npm run check:events
npm test
```

The runner refuses a different current Kubernetes context and creates only a
random `wake-latency-*` namespace. It deletes its namespace and local credentials
in `finally`. Local logs are under `.tools/wake-latency-*.log`; timestamp-only
samples and digests are committed in the raw receipt. Full checks use stub
providers; paid-call and shared-stack opt-in flags were disabled.

## Failed fixture attempts and remaining qualification

Two initial setup attempts failed on missing/wrong conversation key provisioning;
one turn attempt timed out because the fixture used a gateway DNS name while
the computer policy blocks DNS. The corrected harness uses the stub Service IP,
matching the dev stack's IP-based gateway setup. Those three namespaces
(`wake-latency-1c6ae8fc`, `wake-latency-68e1b30a`, `wake-latency-b8d76801`)
were deleted and do not contribute latency samples.

**NOT RUN:** a fresh full application install, authenticated browser journey,
real-provider response time, encrypted/cloud CSI, clean-host or uncached-image
wake, sustained load, hosted CI, merge and push. This receipt qualifies the
isolated real-computer/stub wake path and source safety, not the full capability
on a fresh customer installation. The shared dev stack was neither stopped nor
redeployed. Nothing was pushed.
