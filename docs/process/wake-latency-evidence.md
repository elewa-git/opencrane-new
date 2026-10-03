# Wake latency evidence — 3 October 2026

**PASS for the stub wake latency budget:** five runs before and five after.
Median `message.posted` → first Codex token fell from **11.462 s** to
**8.944 s** (22.0% lower), with an after spread of **7.816–10.079 s**.
This is faster than the owner's accepted 10–14 s target.
Real-provider latency is **NOT RUN**.

## Source and environment

Base: `113854436bc4b4caaae595ac222b5c45d5834cd3`, branch `work/wake-latency`.
After means the lifecycle and bridge changes in this receipt's commit; exact
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

## Method and stage measurements

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

1. Reconcile a claim only for `computer.claimed`. Resumed and ready computers
   already have a binding and retained PVC. This removes four serial kubectl
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

## Checks and safety qualification

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
| Independent review, passes 1 and 2 | PASS; no blockers; source hashes and every table statistic verified |

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
node --experimental-strip-types infra/dev-stack/wake-latency.ts after
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
