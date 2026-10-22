# Models and silo spending

For people, read [README.md](README.md) first.

## Saved-thread native consent capture

`test/codex-native-capture.test.ts` runs only with `CODEX_CAPTURE_IMAGE` set to the
existing computer image. It starts normal disposable NATS, PostgreSQL and OpenFGA
fixtures and the pinned gateway. A Unix socket carries the container's MCP calls
to that gateway while the container uses `--network none`. Model replies stay local.
The fixture grants no production consent. It uses the existing requester decision
command to reject each Ask and checks that the upstream received no tool calls.
Both successful and failed capture output go to `capture.json` with mode 0600
inside the run's private temporary directory. The existing cleanup removes that
directory. No capture output is kept outside it. Ordinary tests check both output
paths, the permissions and removal without needing the capture image.
See [the commands and results](../../docs/process/p3-5-pr12capture/receipt.md).

## Test dependencies

The conversation activity, direct-mode, participation and delegation replay tests live
here because they use models. They use `@opencrane/projections/testing` for disposable
PostgreSQL databases. Set `PG_TEST_URL` before running them.

## Egress socket checks

P3-20 #61 PR 2b is split again to keep this change near 600 lines.
`src/egress-guard.ts` provides `connectEgressDestination` for the relay registry.
It validates host/port with `egressDestinationSchema`, reads a TLS ClientHello,
resolves every address, checks all answers, then connects to the first checked IP.
The caller receives the paused incoming socket's buffered bytes and the connected
upstream socket. It must forward those bytes and own both sockets afterwards.
There is no fallback or connection pool. Each call resolves again.

Each read, DNS lookup and connection attempt has a one-second deadline. A ClientHello
must fit in one TLS record and at most 16 KiB of buffered input. TCP fragmentation
is supported; a ClientHello split across TLS records is conservatively refused.
Exactly one visible SNI name must equal the approved, normalised hostname. Missing
or repeated names, duplicate extensions, malformed lengths and ECH are refused.
Errors use fixed reasons and never include bytes, DNS replies or underlying messages.
The production defaults use `lookup({ all: true })` and `net.connect` with a checked IP.
Tests inject both functions and map that IP to a recording loopback upstream.

The shared `address-policy.ts` moved unchanged from server integrations. Both remote
MCP discovery and this guard now use it through the models package.
The existing gateway assertions remain. Additional cases use these socket checks
behind real gateway/NATS fixtures and check exact bytes without outer credentials.

`src/egress-relay.ts` owns one loopback listener and both sockets per permit.
Registration validates the destination and accepts expiry only within the next 60 seconds.
Each permit is accepted once per registry lifetime, including after expiry. Used permit
ids remain in memory until the registry is discarded; expired listeners and sockets do not.
A used or closed listener stays bound until expiry and refuses additional connections.
Closing by permit, exact normalised host/port or all cancels pending work and open tunnels.
The injected callback receives one close record even if it throws. It runs synchronously
and must not block. Counts are bytes written to each socket, including the initial hello;
they do not prove that the remote application received or processed those bytes.
`connectedAt` is the time the checked upstream connected, or null if it never did.
`address` is the checked IP passed to the connector, or null before that step.
Reasons are finished (socket ended), failed (transport error), refused (guard refusal),
expired, revoked (explicit closure) or unavailable (explicit outage closure). The first close determines the record.
The gateway fixture registers one relay after each allowed guarded CONNECT decision.
Production admission tests also run the startup receipt wiring. Routing-only tests
keep their relay checks without adding receipt file and event writes.
Own checks are in [the relay receipt](../../docs/process/p3-20-pr2c-relays.md).

NOT BUILT: checked-set fallback. Startup wiring is described below.
Capabilities and admission rules are described below. Watchdogs remain later work.
Durable closure receipts are described below.
CONNECT stays off at startup. Fresh-install egress qualification remains NOT RUN.
Own checks are recorded in [the receipt](../../docs/process/p3-20-pr2b-guard.md).

## Durable relay closure receipts (P3-20 PR 2d; Part of #61)

`createEgressReceipt` is private to this package. Create it before registering a relay,
with its trusted silo, request, permit, channel and exact destination. Its stable id
hashes JSON `[silo, permitId, "tunnel-close"]`; the stream is `egress-<requestId>`. Pass `capture` to the existing close
callback. The callback copies validated fields into one pending record and starts
one asynchronous save; both sockets have already been destroyed. It rejects changed
records. The private caller owns the directory and one receipt object per relay.

The writer retains one JSONL file of at most 4 KiB with mode 0600. It syncs a temporary
file, links it without replacing existing evidence, then syncs the directory before
appending. Disk failures retain the record in memory. Store failures retain it on disk.
`retry` joins an in-flight save, otherwise attempts one append with a one-second
store deadline. Each read also has a one-second deadline. No retry timer is installed.
The saved event must match the original before status advances to saved. The evidence
file stays available for explicit restart recovery; this function scans no directory.
It returns pending on unavailable storage and never repeats network work.

`egress.observed` stores the callback fields and destination digest. Finished, expired,
revoked and unavailable closures have unknown outcome; failed and refused have error.
No closure proves successful processing. Invalid or foreign files are refused before
append. The event parser requires the silo-derived id, stream and system/models source.
This is application validation; separate process NATS credentials remain #432.

Tests use the pinned gateway, recording upstream, real NATS and PostgreSQL audit replay.
Automatic outage detection and native enablement remain later parts. Admission,
capability binding, revocation checks and restart scanning are described below. The authorised original-receipt API
is deferred to keep this part below about 600 changed lines. The existing audit table
rebuilds receipt ids and outcomes; richer safe connection detail reads are still deferred.
Production CONNECT and command networking stay off. Fresh-install qualification: NOT RUN.

## Native egress route qualification

P3-20 #61 PR 2 is split at the gateway prerequisite to stay below 600 changed lines.
This first part adds `startGateway.egressDecisionUrl`. No process entrypoint sets it;
ordinary startup leaves CONNECT disabled. The opt-in control URL accepts only HTTP
on `127.0.0.1` with an explicit port and no credentials, path, query or fragment.
Only the `computer-egress` JWT audience can reach this route. Model, MCP and provider
routes retain their separate audiences.

HTTP extAuthz copies the incoming method in agentgateway v1.5.0. The control call
overrides `:method` to POST and passes the CONNECT authority and verified bearer.
The dynamic backend reads only `extauthz.relay`. A route rule requires a numeric
loopback relay address. Missing metadata has no caller-host fallback. Request
headers are replaced before relay forwarding. No retries are configured.

`BudgetActor.admitDispatch` now accepts the non-metered `computer-egress` call kind
without a money hold. It uses the existing queue, saved stops, current-access
callback and single-use dispatch event. Paid model calls still require a matching
open hold. The fixture saves a decision first and consumes this gate before replying
to extAuthz. The production admission handler is described below; startup keeps it off.

`test/egress-gateway.test.ts` uses real disposable NATS and the checksum-verified
gateway with a recording loopback relay. The control service is a test fixture.
It also verifies tokens strictly; the gateway JWT check alone permits clock skew.
The fixture is not a production capability issuer or policy reader. Its optional
relay registry tests the socket checks and closure described above.

Remaining PR 2 work: authorised receipt reads, outage watchdogs and open receipts. Durable close/outage receipts
are described above. The binary removes raw Host before extAuthz;
authority/Host disagreement still needs proof or the accepted broker fallback.
The first routing-only receipt did not cover DNS or TLS checks. Open-tunnel expiry
is now tested through the real gateway. Fresh-install journeys remain NOT RUN. No worker or browser uses this route.
The [receipt](../../docs/process/p3-20-pr2-gateway.md) records this limited proof.

## Dated MCP catalogue evidence

Tool lists carry check and expiry dates; undated lists cannot authorise calls.
`tool.approval_requested.policySequence` stores the stable `policyRevision`,
not the latest MCP stream position. Unchanged checks keep waiting approvals valid.
Failed checks advance that revision, so a later successful check cannot revive an
unread pending approval. Saved drift stays held through discovery, review and legacy
publication. `test/mcp-dispatch.test.ts` checks zero fixture calls after gateway restart;
this is not a watch-worker restart test. The remaining work is listed in the
[durable hold contract](../projections/README.robot.md#durable-drift-holds-48-pr-3-first-part).
The [projection contract](../../libs/projections/README.robot.md#dated-mcp-catalogue-evidence)
records snapshot and expiry rules for #48 PR 1.

The shared policy reader checks complete saved definitions and hashes before keeping
review choices or renewing catalogue evidence. It binds every event to its exact MCP
server and silo. `test/codex-mcp.test.ts` seeds bad saved records to check gateway refusal
and unused waiting approvals. Model test fixtures now use complete checked definitions;
access deadlines, volume limits and gateway assertions remain unchanged.

MCP decisions use one saved history for both tool rules and review details. They do not
read the same history again for review text. Memory discovery keeps recall available
when remember is blocked, including with slow catalogue reads. The two-second deadline,
current grants and permissions, catalogue hashes and expiry checks still apply.

Memory discovery checks recall once and uses the same checked catalogue to decide
whether to list remember. `toolDecision` supplies the existing review, mode and zero-cost
rules for both. The backend repeats its own access check; write confirmations still
read current policy. The slow-read regression keeps the original two-second lifetime.

## Shared child model calls

The turn pass may carry `sharingClass: shared_only` only when the server saved that
class on the matching `computer.turn_started`. The pass keeps this separate from
`executionMode`. Model calls use the sender and the child assistant's recorded payer.
MCP and memory routes refuse the class before reading tool policy or issuing a memory
pass. A private turn cannot claim the class, and a shared child cannot omit it.

## Internal descendant admission

`admitDescendant` saves `computer.turn_started` and then a version 1
`delegation.started` for a signed internal decision. Each stage makes its own conditional
append to one stream. It returns `{ admission, start }`, both original stored events.
No route or production signer calls it. Native calls remain disabled. Admission requires
a matching saved root allowance and paying group; it cannot create or resize one.
The native bridge, thread grants and Stop work remain in later design rows.

The decision uses ES256, the configured issuer, audience `delegation-admission`,
`typ: descendant-admission`, the silo, and the full native start binding. It expires
within 120 seconds. Its `jti` and delegation id are the SHA-256 of the JSON array
`[silo, rootId, computerId, generation, spawnItemId, threadId]`.
No signature, another audience or a changed signed payload refuses admission.

Admission accepts private agent sessions with an explicit `memory_free` root, or
`shared_child` sessions with a `shared_only`, `restricted` root. Both require a saved
model/provider choice. Shared children copy `sharingClass` into both admission records
and keep `dataClass: shared`; private children keep `dataClass: private` at every level.
Shared admission checks the chat and assistant payer and current group membership.
It reads child and parent participation before the two-second authority check, then
reads only later changes. Inherited joins must still match the original parent joins
for the requester and chat creator. Rejoining the parent does not restore inherited
access; an explicit child join can grant a new period. No authority watch is added.
`test/shared-descendant-admission.test.ts` covers both levels, copied fields, narrowed
scopes, stale OpenFGA allows, closure, Stop, payer mismatch and two competing replicas.
Descendants keep the requester, payer, generation, conversation, model and provider.
Their model scopes narrow the recorded parent maximum; every other scope stays empty.
Current permissions and applied grant receipts are checked again, including inherited
revocations while OpenFGA still returns an earlier allow answer.

The computer stream enforces two descendant levels, four lifetime children per parent,
eight lifetime descendants per root and four active descendants. Closes free only
active slots. A conditional append serialises competing replicas. Conflicts reload
and repeat validation, within ten attempts and the original ten-second deadline.
Retries compare the whole binding and return the original event. Changed retries refuse.
After every successful append result, admission reads that exact stored position and
checks the event identity and full binding. Duplicate recovery cannot return a caller's
proposed event when another replica saved different scopes under the same id.

The start is copied from the saved computer admission, with that event's exact id and
position in `computerAdmission`. Its event and command id are
`delegation-start:<delegationId>`, on `delegation-<delegationId>` with expected position 0.
Retries read saved records before appending and work beyond the NATS duplicate window.
A competing append must match the original record. Missing or unavailable status never
allows an unchecked append or grants permission. Legacy starts and changed fields conflict.

`readDescendantAgreement(store, silo, assistantId, delegationId, deadline?)` reads the computer
history and the original delegation start within ten seconds. It returns the same pair
only if their full delegation binding and admission reference agree and the computer
admission is open and the delegation has no later record. The optional deadline replaces
the ten-second default. It performs no append or effect. Read errors contain no binding values.
The future minting caller must also check current root, access and spending rules.

History and grant summaries load before the two-second access check. That check watches
only the existing small authority streams. Later root activity is read incrementally.
`test/descendant-admission.test.ts` uses real NATS, PostgreSQL, OpenFGA and gateway
fixtures. The duplicate-window test uses the already installed Apache-2.0 NATS client
(`@nats-io/jetstream` 3.4.0), declared as a test dependency.
`test/delegation.test.ts` retains the refusal of native credentials and calls.
The tests cover lost replies at either append, retries after NATS duplicate expiry,
competing starts, changed bindings and references, missing/legacy/closed records,
unavailable reads and projection replay. These records grant no call authority and
create no budget event, hold, token or upstream call. Live native qualification: NOT RUN.

## Native child spending checks (P4-11 PR 2f; Part of #93)

`requireDescendantAllowance` reuses the budget event summary. Admission and native
calls must match the saved root id, root turn/thread, requester, conversation,
assistant, computer generation and paying group. A saved root stop refuses them.
Spending history loads before the short access check; later confirmations read
only new events. No conversation stream is added to the authority check.

`reserveNativeCall` is an internal operation with no HTTP route or production caller.
Its inputs are already verified computer/turn claims and the raw request body.
It computes the call bound in integer cents and repeats the access checks used by the
HTTP refusal path, then uses the budget actor's existing queue. The actor accepts the
checked root turn/thread separately and retains the child's identity on the hold.
It checks access before capacity, so stale access cannot create an exhaustion stop.
The same hold counts towards root, group and global totals. No child allowance is made.

The real fixtures run two decision services and separate event-store clients against
one budget writer, NATS, PostgreSQL and OpenFGA. Both HTTP services still refuse all
native calls before reading their bodies. Internal concurrent holds test 240 settled
plus 110 held, competing 400/300 bounds, permanent root refusal and an unaffected root.
Settlement tests cover 300/200 holds settling at 180/120, duplicate settlement,
release of an unsent 90, retention of an unknown 110 and fresh-actor replay.

Scope is PARTIAL: this is the saved allowance and internal capacity part of row 2.
Trusted call/body binding, token minting, authenticated bridge evidence and the
remaining restart/Stop races are deferred. Internal request-cost and root dispatch
checks are described below. Both multi_agent settings and native credential issuance
remain off. Fresh-install qualification: NOT RUN.

## Budget writes

Native calls pass through `native-call-check.ts` before conversation activity for an
ordinary turn, request body reads, policy, approval, budget checks, holds or dispatch.
Private and shared native chains have the requester followed by one or two saved delegation ids.
Every signed turn claim and the authenticated computer identity must match the saved
admission. The selected model must also belong to its recorded scope. Both records
and parent records load within the decision's original two-second deadline, before
any authority check. The shared admission helpers check root and parent bindings.
Root Stop, completion, closure and computer changes refuse; unrelated activity does not.
A matching call ends with `NativeDelegationDisabled`; `decisionError` exposes
its fixed message. Access errors contain no ids. No new watched stream is added.

`descendantAccess` in `descendant-admission.ts` supplies the same access checks to
admission and native calls. It checks current requester and assistant permissions on
the saved model, applied grant receipts, shared participation and the saved payer's
team membership. The call supplies the original decision start and deadline to every
store read and the two-second authority check. Histories load before that check;
confirmation reads only later activity. No additional stream is watched.
Shared calls require the saved shared-only class. Parent leave/rejoin cannot restore
an inherited child join; a new explicit child join can. The personal-assistant test
uses a team payer saved only on the turn records, so another team cannot substitute.
`test/native-call-access.test.ts` proves both depths reach the disabled refusal on the
model, MCP and memory routes, then refuse stale revocations and lost participation or
payer membership. Invalid JSON and observed reads prove these checks precede body,
policy and approval handling. Budget positions, holds and dispatches stay unchanged.
Native admission and calls now require the saved allowance described above.
Minting, bridge work and Stop execution remain separate.
`test/native-call-check.test.ts` uses admissions made by `admitDescendant`, real fixtures,
individual changed claims, unavailable reads and exact final refusals on model, MCP
and memory decision routes. Native credentials remain disabled. Live qualification: NOT RUN.
The delegation records themselves grant no spending authority.
`test/delegation.test.ts` checks legacy and native refusals through the real gateway,
with zero upstream calls and zero reservations.

BudgetActor replays every budget event before writing. Its appends opt into the
event store's `historyChecked` mode, using the last applied sequence. Ordinary
commands use fresh UUIDs. Configure checks its caller's command id against the
history before appending. A lost reply is found after the original position;
another writer's event causes a conflict and disables the old actor.
`test/actor.test.ts` checks reservation reads on 500 events, configure repeats
and the old actor stopping without holding money.

## Recovery after store outages

Model sends and provider checks use `BudgetActor.admitDispatch`. It saves one
`budget.call_dispatch_admitted` after checking stops, capacity, the hold's binding
and current access. It changes no cents and never counts a hold twice.
The [event contract](../../docs/architecture/events.md#budgets-single-writer-actor-per-silo) lists its fields.
Reachability checks need no hold. Managed model calls remain disabled.
Tool and memory sends use this same gate, with `model: mcp-zero-cost` and no hold.

A retry of a provider check never sends it again. It returns the original receipt
without writing while the first check may still be running. Recovery can finish
an attempt only after its reservation is older than the 15-second gateway timeout
plus a five-second margin. Without a reservation, the original request must be
older than that same limit. When no dispatch exists, recovery records
`provider.verification_recorded` with `outcome: unknown` and the original
reservation id, if one exists. It includes settled cents only when the local
budget actor has already settled the hold; otherwise the budget stream shows
whether the money is still held or has been released.
The successful append permits one gateway send; duplicates return no permission.
The pinned routes have no send retry policy. A lost append reply stops the actor
and keeps the hold. Provider attempt records follow this common gate.
New holds carry `dispatchGate: 1`. Expiry uses the same queue and conditional
append. It releases a new hold only without admission or other call evidence.
Failed evidence reads retain money. Older holds stay uncertain because their
senders did not use the gate. Expiry first saves `budget.reservation_expired`
with the reservation id in the budget queue. The shared fold marks that hold
`expired: true`; admission refuses it without changing its held cents.
Replay restores the refusal even with an earlier clock. Later usage still settles
the original hold. Provider gateway failures release only holds made under the
new gate; older holds stay uncertain. Explicit release refuses admitted calls or evidence.

When an allowed call reports an unknown result after a zero-cent release,
`uncertain()` saves `budget.settled` with `settledCents: 0` and `outcome: unknown`.
This makes the full reserved amount count against spending limits again without
claiming a known charge. Duplicate reports do not write another settlement, and
replay restores the same hold. Without an allow decision, the report raises
`effect_without_permit` and does not restore the hold.

`test/dispatch.test.ts` uses real NATS and the pinned gateway with a recording
upstream. It checks both sides of the stop boundary, lost replies, duplicate ids,
replay and both expiry orderings. Legacy expiry tests assert zero upstream
requests and refusal after replay with an earlier clock. Separate tests cover
unknown holds, each duplicate key, capacity without a saved stop and revoked access
before recording exhaustion. `test/hold-leadership.test.ts` checks stale writers
and admission queued behind expiry. `test/actor.test.ts` keeps legacy holds and
later evidence conservative. `test/hold-recovery.test.ts` covers store outages;
`apps/server/test/providers.test.ts` checks the provider path and expiry before
admission. These tests send no paid model request.

Phase 2 #29 and Phase 3 #54. The decision process verifies the lifecycle computer and
thread-bound turn tokens; agentgateway v1.5.0 enforces its answer and sends
Responses requests to OpenAI. Reuses S0.2's ext_authz/header allowlist and
S0.1c's native streamed usage fields and checksum-verified binary fetcher.
Before switch-on, startup uses `backendAuth.key.file` to read `.keys/.openai-key` inside
agentgateway, never the server or computer.

### Managed gateway proof, part of #104

`startGateway({ managedCalls: true, ... })` makes `/v1/responses` ask
`/authorize/models/managed`. The shared `gatewayConfig` builder supplies this
route; the default remains `/authorize` with the deployment key file.
The optional route omits `backendAuth`. It takes `x-provider-key` only from the
decision reply into private extAuthz metadata and builds upstream `authorization`
from that value. It also takes `x-reservation-id` for native usage reporting.
Caller headers cannot supply that metadata. The key is not copied into client
responses or the usage file. The route needs no static key file.

`test/managed-gateway.test.ts` uses the pinned v1.5.0 AI backend, a recording
upstream and a scripted decision reply. Its fixture starts real NATS, PostgreSQL
and OpenFGA. It checks two different keys, token counts, caller header isolation,
provider errors, decision refusals and absence of key values from gateway logs,
events and responses. This is a gateway test, not proof of managed admission.

PR 5b adds `/authorize/models/managed`. It requires switch-on and signed claims
matching the recorded turn. `decision-provider` keeps at most 64 exact-provider
summaries, each holding only the latest configuration and verification facts.
It checks the same-silo OpenAI connection, saved-key command and enabled model,
recomputes the custody reference and reads the key before the disconnect guard.
Managed history reads have their own ten-second limit. After history is loaded,
access checks start a fresh two-second limit, shared by custody reads and rechecks.
Only the small access streams are watched. Activity rechecks start at the position
captured before history, so changes during loading still refuse the call.
Model removal refuses; verification, rotation and binding changes do not.
A disconnected client is refused before money is held.

The actor validates the reservation before either switch-on guard. Only complete
managed calls with a request id, generation, dispatch gate and access callback
can reserve after switch-on. A switch-on conflict repeats that callback; another
budget writer still stops this actor. Refusal before send permission releases at
zero. Later usage keeps the saved payer and tariff, with once-only settlement.

Own checks and remaining qualification are recorded in the PR. Tests cover real
switch-on, restart without custody reads or new holds, model-selection races,
cold and warmed 5,000-event provider histories, shared custody and concurrent credentials.
The cold-history test calls the decision HTTP endpoint and delivers 5,000 saved
events to an empty decision summary after a controlled delay beyond two seconds. It also checks the fixed refusal and zero money held after the history
limit, and refusal when access changes after history. The gateway still stops waiting
after two seconds; these tests do not claim a cold call through that gateway succeeds.
The models process now selects this mode from recorded switch-on and refuses a
leftover fallback file setting. `startGateway` needs no key file in managed mode;
legacy configuration requires one. `GatewayRenderSettings.managedCalls` preserves
the mode through worker reloads. Dev-stack custody wiring remains for PR 5d.
No stack or paid provider call proves this route yet.

- `BudgetActor` loads the NATS budget stream and serialises reserve/settle
  commands. Each command does one conditional append. The process entrypoint
  uses the existing PostgreSQL session lease adapter to elect one actor;
  an append on acquisition fences the previous writer. Unknown append outcomes
  stop the actor. SQL holds no budget rules or authoritative state.
- Defaults are **2,000 cents/day and 20,000 cents/month**, UTC. Pending
  reservations count against both periods until settled, including after
  midnight or a restart. Completed calls belong to their reservation date.
- Owner decision, 2 October 2026: allow all eleven requested models and keep
  optimising; choosing the right tool matters more than cost. The registry in
  `src/state.ts` is the only price data: Astra, 6.1 Sol, 6 Luna, 6 Sol,
  5.6 Sol/Terra/Luna, 5.5/5.5 Pro and 5.4/5.4 Pro. `gpt-5-nano` and
  `gpt-5-mini` are retired and refused for new calls. Their original price rows
  remain available to settle pending reservations at the recorded tariff.
  Standard rates are pinned from
  [OpenAI pricing](https://developers.openai.com/api/docs/pricing), checked
  2 October 2026, at the existing planning FX of EUR 95/100 USD. Prices are
  integer euro cents per billion tokens, preserving fractional USD-cent rates.
  BigInt arithmetic rounds the combined charge upwards once per call.
  Short context is **at most 272,000 input tokens**; above that, the whole
  request uses long-context input, cache and output rates. Settlement uses
  total input to choose the tier, then charges reported cached input and cache
  writes at their separate rates. Unsupported cache usage fails closed.
  This is a planning tariff, not invoice reconciliation or live FX conversion.
- `src/routing.ts` holds the task table and one selection function, following
  [OpenAI model guidance](https://developers.openai.com/api/docs/guides/model-selection).
  Chat turns use **gpt-6.1-sol**. Ambiguous problems, deep analysis and ambitious
  deliverables use **gpt-6-astra**. Scoped tasks, triage, frequent automations,
  conversation titles, upload classification and summaries use **gpt-6-luna**.
  The bridge accepts an explicit task kind (default `chat_turn`) and selects
  the model on every turn, including resumed threads. It never guesses task
  difficulty from message text. Refine the rows using measured success, latency
  and spend; there is no learned router. Automation execution is still future work.
- `requestReservationCents` reserves this request's input and output bounds.
  The UTF-8 byte count of its serialised, decoded body bounds text tokenisation.
  [Provider rendering](https://developers.openai.com/api/docs/guides/token-counting)
  also adds roles, boundaries and tool formatting. Add **2,048 tokens per request
  plus 64 per JSON object**, covering messages, content/input items, function outputs
  and tool definitions, including the wrapper and nested schema objects. This is
  generous planning headroom, not a provider guarantee. The padded bound selects
  long rates **above 244,800 tokens** (90% of 272,000), leaving a safety band.
  Cached-input
  discounts apply only at settlement; the greater uncached input/cache-write
  rate covers cache writes too. Output is the supplied limit times `n` (only
  `n = 1` is accepted), and the combined cost rounds up once. Input plus output
  bounds above **1,050,000 tokens** are refused before reservation or dispatch.
  `reservationCents` retains its full-context fallback for callers without a
  proven bound; admission always supplies the measured request bound.
  If observed settlement exceeds its reservation, charge the full actual cost and
  raise one `security.alert_raised` with reason `budget_reservation_exceeded` and
  `overrun: { model, reservedCents, settledCents }`. All ceilings use that actual
  spend on later admissions, including after recovery. Alert retries do not charge
  twice; an alert outage cannot erase the settled cost.
  Only inline text and local function/custom calls are accepted. Media, hosted tools,
  stored history, background requests, multiple completions and premium tiers
  fail closed. The caller supplies `stream: true` and `max_output_tokens` from
  16 (the [API minimum](https://developers.openai.com/api/reference/java/resources/beta/subresources/responses/methods/create))
  to 2,000. Codex function/custom call history, string or text-block custom results, tool-result IDs, reasoning
  continuations and assistant message phases are preserved; unknown fields remain refused. The gateway fixes the
  service tier to standard pricing.
- IAM uses current requester ∩ assistant resource grants in live OpenFGA.
  The claimed computer generation, ready state, conversation and active turn
  are read from events on every call. JWTs are ES256, with strict expiry;
  turn claims include `thread` matching the actual Codex `session-id`, signed `conversation`, `requester`, `task` and allowed `model` and the current
  `computerTokenId`, with at most 120 seconds between `iat` and `exp`.
  The server chooses the allowed model from the task-routing table; admission
  refuses a different request model before reserving or reaching the provider.
  Both use `libs/auth` and the configured `TOKEN_ISSUER`; the gateway verifies
  the same public keys. Computer tokens include the claim generation, and
  only a matching Ready event permits model admission. Ordinary turns carry only the
  requester in their delegation chain. Native calls can carry two descendant ids,
  but still refuse after the saved-record checks described above.
- Only reservation ids, token counts and a fixed error outcome survive the gateway log filter.
  Observations are appended as `effect.observed`; the existing handler runtime
  delivers `settle-budget` to the decision process. Its settlement endpoint
  accepts an event reference and rereads the recorded effect, never a supplied
  amount. A duplicate effect cannot charge twice. Observed provider rejections
  without usage settle at zero cents. Timeouts, lost connections and other
  missing outcomes produce `effect.uncertain` after three minutes and retain
  the full reservation. Unknown models or tariffs produce `effect.uncertain`
  with reason `unknown_tariff`, keep the reservation and allow later usage
  lines to be processed. Cap refusals append `budget.exhausted` and a separate admission decision, once per
  unchanged configuration and scope per UTC day for exhaustion, including across actor recovery. All decisions use `decision.recorded` with a digest of the
  verified context when available; gateway JWT failures occur before ext_authz.
- `budgets` is a PostgreSQL projection using the existing runner. The worker
  upgrades projection version 2 by replaying legacy rows before resuming.
  Rebuild online with `npm run replay -- budgets --verify`; a repair changes
  the generation and preserves the live table's reader grants.
  `GET /api/org/models` uses live owner/admin authorisation and returns models, prices, the task-routing table and context threshold,
  today's/month's settled cents, outstanding reserved cents and both ceilings.
  Its `budget` field includes each configured group/assistant ceiling and totals.

The prototype stores reservation history in one JSON projection row and rereads
small entity histories. Large histories need compaction/indexing later; the event
stream remains the source of truth. Manual resolution of uncertain effects and
price administration are Phase 3 work. A hold that may have been sent is never
refunded by time. A hold that was never allowed or sent is released at zero cents.

## Monthly budgets (P3-13)

`BudgetActor.start(2000, 20000, 'personal-default')` seeds the installation's
explicit default paying group on a fresh stream. Existing streams keep their
recorded configuration; an Owner/Admin must configure a missing default before
new personal work can start. The server binds personal work at turn admission;
shared work must name its group in `conversation.created.payingGroupId`.
Decisions only use `computer.turn_started.payingGroupId`. Retries and descendant
calls retain it; changing the default affects newly admitted work only.

`configure` queues one `budget.ceiling_set` behind the same fence as reservations
and settlement. A reservation checks global daily/monthly plus any paying-group
and assistant monthly limits once. It records one charge, attributed to all
applicable scopes. Totals use BigInt arithmetic and refuse unsafe aggregate
values. UTC rollover preserves unknown reservations and original settlement
attribution. The existing process timer records the first of each month at 00:00.

Owner/Admin reads and writes `/api/org/models`; POST accepts `commandId`,
`expectedSequence`, `scope` and `ceilingCents`, plus `scopeId` for a group or
assistant. Global writes may set `dailyCeilingCents` and `defaultPayingGroupId`.
Amounts are non-negative safe integer EUR cents. Zero is a hard stop; scoped
ceilings are optional until configured. Conflicts return 409; refresh before
editing again. Origin is checked on writes. The server signs a 30-second command
capability bound to the exact JSON; `/budgets` verifies it and rechecks live
Owner/Admin and current membership after history and queue waiting, inside a
two-second authority fence immediately before the append. Never send a bare asserted member id to the decision process.
The screen at `/org/models` shows spent/reserved amounts and configures ceilings
at desktop and 390px. Phase 4 group administration remains separate.

Model multiplicity stays one, with a positive bounded output limit and the
existing conservative prompt bound. Unknown tariffs, overflowing/fractional
money and provider tools with unreviewed cost are refused before dispatch.
Reviewed non-metered MCP tools, including Odoo fixture calls, must explicitly
carry `costCents: 0` in discovery. A hold that may have been sent is never refunded
by time. A hold that was never allowed or sent is released at zero cents.
P3-14/P3-15 own hard-stop cascades and evidence-based uncertainty resolution.

## Run and test

`apps/server/src/models-main.ts` is the supervised process entrypoint; the dev
stack supplies its NATS command credentials, projection database, silo/OpenFGA
binding, lifecycle public JWKS file, `TOKEN_ISSUER`, state directory and three ports. On a fresh stream, the model process explicitly
records `installation-default` as the personal paying group; installation may
override it with `DEFAULT_PAYING_GROUP_ID`. Replay never replaces a stored default.
`MODEL_DECISION_URL` and the existing `TOKEN_SIGNING_KEY_FILE`/`TOKEN_ISSUER`
enable the server configuration route. In development its URL defaults to the
existing loopback decision listener, `http://127.0.0.1:43001`; the decision process only needs public JWKS.
`MODEL_UPSTREAM` and `MODEL_KEY_FILE` select the dev-stack stub; the default
production upstream remains OpenAI. Dev-stack startup always selects the stub. Only the public JWKS
is read by this process. The issuer's private signing key stays with the issuer.
`apps/ops/src/worker.ts budgets` runs the projection; the dispatcher enables
settlement when `MODEL_DECISION_URL` is set. An existing dispatcher needs a
controlled subscription rebuild before enabling the new handler.

```sh
bash spikes/s0-1c-real-model-smoke/scripts/fetch-tools.sh
PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres npx vitest run libs/models/test/gateway.test.ts
```

Fixtures use real NATS, PostgreSQL 17, OpenFGA, agentgateway and a scripted SSE
provider, each with disposable state. The real-call test is disabled normally;
`MODELS_REAL_CALL=1` explicitly enables exactly one call each to Luna, 6.1 Sol and Astra with
`Say OK.`, 16 output tokens and low reasoning (select that test alone).
Never rerun it as a normal gate. [Evidence](../../docs/process/models-evidence.md)
records the authorised call and test qualification.

Licences: agentgateway v1.5.0 Apache-2.0, jose 6.2.12 MIT, zod 4.6.5 MIT;
all other runtime code reuses existing OSI-approved workspace packages. No new
third-party dependency version was introduced. The binary SHA-256 is verified
before every launch; the k3d relay image is pinned by OCI digest too.

P2-3 also verifies the native Codex text request shape through the real gateway:
nullable message ids, input/output text, reasoning summaries, local function
selection, parallel calls and cache/client metadata. Native Sol text turns also
carry strictly checked tool declarations (including namespaces and Lark custom
tools), top-level local custom tools and namespaces, `all_turns` reasoning context and text verbosity. These fields do not relax
the output limit or admit media, hosted tools or stored-history references.

## Per-tool policy (P3-1)

`readToolPolicy` folds the installed server stream; `setToolPolicy` checks live
Owner/Admin plus current event membership and performs one conditional append.
Discovery hints suggest choices, never grant access. Modes bind `connectionId`
and `toolRevision`; changed discovery resets to Block. The existing catalogue
projection replays the same fold. Org settings links each register row to its
Tools & access screen, using the authenticated GET/POST
`/api/org/integrations/:serverId/tools` interface with Origin checks on writes.

`startGateway` adds fixed, operator-reviewed `/mcp/:serverId/:connectionId` routes.
The gateway sends installed tool calls to the models process at `/dispatch/mcp/...`.
Only explicitly credential-free, reviewed tools priced at zero can run. Discovery
and descriptions cannot declare a transport safe. The original JSON bytes stay intact.

`mcpDispatchRouteSchema` accepts `serverId`, `connectionId`, `upstream` (host:port),
`generation` and `revisionHeader: 'x-opencrane-mcp-revision'`. Missing generation or
revision contract denies calls. The operator must qualify that backend: it must compare
both `x-opencrane-mcp-revision` (catalogue digest) and `x-opencrane-mcp-generation`
(exact running instance identity) atomically before tool execution. HTTP 409 never retries.
A declaration in an untrusted tool description is not a qualification.

The final send consumes a signed, process-bound permit. Its request id links to the saved
allow decision and its requester, assistant, conversation, turn and call id. It also binds
silo, exact body digest, policy/tool/catalogue revisions, connection and backend generation.
It expires within two seconds or at catalogue expiry, whichever comes first. The saved
access callback retains the original two-second deadline. Pending permits are bounded to
1,024; expired entries are dropped before issuing another. Restart drops them all.

The final check confirms leadership and current access within the original two-second
access deadline. It consumes each pass locally even on refusal, then conditionally
appends `mcp.dispatch_admitted` to `mcp-<server>` before sending. The expected sequence
covers the same stream as `setToolPolicy`, unpublication and tool-change quarantine.
If Block or a hold was saved first, admission conflicts and refuses. If admission was
saved first, that call may proceed; the later Block applies to later admissions.
Replay never sends a call or restores the process-local pass.

The sender tries admission at most three times. It retries a conflict only when every
new row is another call's admission. It reads only rows after its checked position,
checks access again and keeps the original deadline. Policy, freshness or hold changes
refuse the pass. Admission advances the write position without changing tool rules,
approval revisions or evidence dates. It therefore does not refuse another caller's
access check. The repeat-until-matching access passes have been removed.
The unchanged authority tests keep their original deadlines and volume limits.
Waiting approvals retain their stable policy revision and can obtain a fresh permit.
The final check reads no complete catalogue or conversation history. Only reviewed transport headers leave this
process; permits and caller credentials do not. A substituted backend or generation fails.
Built-in memory uses the same pass, route binding and conditional admission as other MCPs.
The dispatcher signs `x-memory-context` for that pass and sends it only to the backend.
The gateway strips caller credentials and forwards only the one-use pass to dispatch.
Discovery and listing use the recall policy and preserve their original protocol method.
Other hosted images still require image admission and remain refused.
Approvals include `dispatchBinding`, the route hash, in their id. A replaced backend or
generation cannot use an old approval, including a late approval decision.
Hosted image admission, recorded lifecycle generations, configuration acknowledgement and
automatic card cancellation on lifecycle changes remain later design rows. These fixed routes
provide no image admission or installer. The P3-14 shared send gate is not merged; this small
permit check adds no spending gate and can move behind it later.

### Open items

Model and MCP admission share `currentAuthority`: current member/role, team
membership, assistant activation, conversation participation, requester and
assistant grants, and OpenFGA permission checks. Every required event must have
reached OpenFGA before admission. Decision receipts cover the requester, assistant
and team grants, including revoked team grants. Another member's direct grant
needs no receipt for this call.

Legacy model and MCP decisions share one two-second budget for computer credentials, new
computer/conversation events and the access check. The gateway stops waiting
for authorisation after two seconds, so the decision must fit within that limit.
Decisions capture a log position before reading the histories. After reading
them, they watch only the small streams that decide access, using the time left
in the same budget. `decisionActivity` reads only new computer and conversation
events after the captured position. It refuses
participant changes, a closed conversation, changes to the computer's identity or
ready state, and a stop, completion, failure or computer close for the current turn.
The recorded ready computer must match the one that supplied the token check.
Other conversations' computer turn events, file uploads/deliveries/rejections,
posted messages and output reports leave ordinary call access unchanged.
Both activity checks and the shared access check use `outputReportTypes` from
`authority.ts`, including `agent.output_lost`, so their output rules stay in step.

`decisionAuthorityFence` checks only the small member, ownership, assistant,
resource-grant, discovered team and MCP policy streams. It ignores member
invitations, ownership changes for other members, changes to other team members
and direct grants for unrelated grantees. Shared spending checks the caller's
current group membership and waits for that person's changes to reach OpenFGA.
Team grants stay strict because they can supply access to the requester.
The shared `authorityFence` and `conversationAccessFence` keep their existing rules.
Decision checks repeat the activity and access reads together until neither finds
new rows. This catches a turn stop or computer close saved while harmless events
are being checked, before returning a permit. The access deadline stays fixed.
All failures caused by a relevant change retain the exact `Authority changed`
message used by the live-view checks. This design filters unrelated events rather
than retrying a reservation or a single-use approval.

`authorityFence` returns a freshness check with `include(...subjects)`, `head` and
an absolute `deadline`. Decision policy, approval and access reads share the
decision deadline. Store retries and budget-queue waits cannot reset it. Discovered
subjects use the same starting position. Before reservation, approval use and
final admission, a relevant change or an expired check refuses the call. A failure
before reservation holds no money. A destroyed request socket or a disconnected
client also refuses the model call before `actor.reserve`, without holding money.
A failure after reservation releases the unsent hold at zero cents.
No permission result survives a decision. Stream summaries survive, but every
use first reads new events through its own catch-up.

Ask tools keep stricter conversation checks: a posted message or a new turn
invalidates the old approval, as do stops and closes for its bound turn. Decision
approval reads reuse the earlier conversation history, and the final activity
check catches later invalidation. The conditional `approval.used` append still
allows one use only. Approval card listing and human decisions keep their existing
read and write checks.

The tests in `test/decision-fence.test.ts` adapt the event-store probes for #164.
They cover each harmless event and real revocation through model and MCP HTTP
admission, early and late money safety, the computer-token handover, unrelated
projection delays, full-history ordering and single-use approval admission.
They also cover owning and separately granted teams, refusal when history and
access exceed their shared budget, a client disconnecting before reservation,
and a turn stopped or closed while a harmless grant is checked again.
Both routes also run through the real gateway with a decision slower than its
unchanged authorisation timeout. They check that the provider receives no call
and that no reservation or uncertain hold appears after the decision finishes
or after the budget actor checks for expired holds.
The existing gateway and server approval tests cover real gateway forwarding,
late revocation and message invalidation. The tests use disposable services and
scripted providers; they make no paid model calls.

Memory scopes are empty. Personal work retains the installation's paying group;
team turns require an explicit paying-group binding; there is no fabricated
credential/profile. Destination checks can reuse `currentAuthority` and pass the
same fence to include their own policy subjects. This branch does not yet contain
the P3-20 egress route. Counting, race and 100,000-event benchmark results are
recorded in the [authority-read evidence](../../docs/process/authority-reads.md).
Each allow/ask/deny appends `decision.recorded` before forwarding; append failure
denies. A decision is admission, not proof of an observed effect.

`seed-model-grants` reacts to `member.joined` and `assistant.created`, appending
one `grant.given` per active model and grantee. Each command does one conditional
append; conflicts fail for ordered retry. Existing grant history, including a
revocation, takes precedence. Duplicate delivery cannot restore revoked access.
OpenFGA only projects these events; rebuild never manufactures grants.

Existing silos must run the [upgrade command](../../apps/ops/README.robot.md#model-grant-upgrade)
before rebuilding OpenFGA with the updated model and enabling decisions.
The dev-stack startup hook belongs to the separate dev-stack change; no shared
stack files or processes were changed here.

[P3-13 evidence](../../docs/process/p3-13-budgets-evidence.md) records isolated real-service races, replay and UI checks.

P3-19 binds model reservations to `requestId`. The decision's permit joins gateway
usage and budget settlement without reading log timestamps. Normalised gateway
JSONL contains only UUID correlation and usage or bounded failure codes, including
pre-ext_authz JWT failures without an asserted identity. Ingest is idempotent;
event-store failure preserves safe gateway evidence and denies dispatch. Unmatched
model effects raise one security alert rather than charge an unrelated reservation.
The gateway has no retry policy: a lost upstream reply stays uncertain and does
not cause another upstream attempt. The real gateway → recording upstream audit,
JWT/outage, missing observation and replay cases run in
`PG_TEST_URL=… npx vitest run libs/models/test/gateway.test.ts`.

P3-2 adds event-backed single-use approvals at the MCP decision seam. The
`lossless-json-v1` reader preserves number text, sorts UTF-16 keys and refuses
ambiguous keys and malformed Unicode. The original HTTP body is forwarded unchanged.
A reviewed tool's `review` descriptor declares its action, consequence, target field
and complete list of safe scalar fields; missing, extra or nested fields refuse.
Reviews use the conversation's encrypted-content/key-reference convention. Neither
the model nor browser supplies approval authority or replacement review text.

`approvalCards` includes the saved `turnId` in each card. The browser uses it to
check whether that turn stopped.
`approvalCards`, `readApproval` and `decideApproval` replay approval streams; reads
record expiry/cancellation through conditional appends. Shared child callers set
`requesterOnly: true` on `approvalCards`. It excludes other requesters before
loading approval history or decrypting their review. Existing callers retain their
current behaviour. Safe shared approval metadata is deferred to a later contract.
A request is bound to silo,
requester, conversation, logical turn, assistant, server, tool/schema revision,
stable tool rule revision, connection/profile and argument/review digests. Only the original
requester can decide. A current authority fence precedes consumption; audit and a
final fence precede forwarding. A lost acknowledgement burns authority. Consumption
means outcome unknown until a later feature supplies trusted effect evidence.

The P3-1 credential-free connection is the supported fixture here (`profile: none`).
No credential or tool-charge stage is invented: P3-8 owns those, and must reserve
before consumption and audit credential release before forwarding. P3-5 owns native
Codex waiting, grant renewal, notification and continuation; this slice never
redispatches from replay. `CONVERSATION_KEYS_DIR` must identify the same secret-store
adapter for the server and decision process; unavailable keys refuse Ask admission.
The shared gateway fixture is exported as `@opencrane/models/testing` for API tests.

P3-15 adds `readEffect`, `listEffects` and `resolveEffect` for monetary uncertainty.
The command conditionally appends one evidence-backed resolution on the effect
stream; `settle-budget` applies it through the fenced budget actor. Conflicting
observations preserve the largest charge and retain the full reservation.
Status reads replay safe metadata and evidence references without provider calls.
Lists read only `budget-<silo>` and `effect-<permitId>` for each saved reservation.
They keep reservation order and include settled reservations and unknown holds.
Details and resolutions already read these exact subjects; none of these reads
replay chat history. List and detail reads share a ten-second deadline across
their subject reads and fail closed on expiry. Resolution writes keep their
existing two-second membership check and conditional append.
[The HTTP contract and source evidence](../../docs/process/p3-15-reconcile.md)
cover the screen binding, refusals and remaining live qualification.

## Idle polling

`ingestUsage` accepts a `UsageCursor` as its third argument. The models process
keeps that cursor between 100 ms ticks. Its offset counts bytes after successfully
recorded complete lines. An unfinished line or failed event append is retried.
The gateway only appends to the file. If its size falls below the saved offset,
the reader starts at byte zero again. File rotation and rewrites are not supported.
Unchanged files need no content or event-store reads. A new process reads from the
start; saved event ids prevent duplicate records.

The budget actor remembers reservations with saved uncertainty. `expire()` skips
their repeated timeout checks. A restarted actor checks each old reservation once
and remembers the existing uncertainty. Later usage still records its observation.
`test/idle.test.ts` admits calls before checking unknown timeout outcomes. It keeps
the 1,000-cent hold after expiry and restart, records uncertainty once, and retries
an effect write that fails after the budget expiry write succeeds. The final-check
cases in `test/decision-fence.test.ts` inject turn closure during the single access
check after the audit. Their refusal, release and zero-send assertions are unchanged.
Lost-output reports grant no authority. The existing output-report allowlist
accepts `agent.output_lost` so it cannot refuse an in-flight call or a reader.
Private turn admission keeps its existing small access streams.

## Resolution history and access

`resolveEffect` reads the reservation and effect events with one ten-second history
limit before starting its two-second member access check. The HTTP access callback
starts after history too, and is checked again immediately before the append.
Member removal during history or between the checks refuses the write. After the
member check starts, the command compares the budget stream's latest position with
the last position applied during history. If it changed, the command reads only
new events within the member check's deadline. It checks their silo, applies them
to the budget state and rebuilds the hold's status before making its decision.
A hold released during the first budget read returns `conflict` without saving a
resolution. An unchanged budget needs no second read.
Resolution still makes one conditional append to `effect-<permitId>` with the
caller's expected sequence; a concurrent resolution still conflicts. It never writes budget state.

`test/reconcile.test.ts` covers history ordering, removal immediately before saving,
access-check expiry and a concurrent effect write. `test/actor.test.ts` covers a
lost reservation reply followed by a successful reservation at the next position.

Known follow-up for a later #210 PR (M1): `readEffect`, `listEffects` and
`resolveEffect` still read the whole budget stream once. The ten-second history
limit can refuse these requests as the stream grows. A budget summary or an index
for each hold should replace that full read. This PR only catches up new events
after the initial read. A budget change between that catch-up and the append can
still race the decision within the two-second access limit, as before. Closing
that gap needs an append condition that also covers the budget stream.

`apps/server/test/integrations.test.ts` covers a hold released during the first
budget read and a saved admin role whose OpenFGA admin permission is denied. Both
refusals leave the effect stream without `effect.resolved`.

## Tool activity during access checks

`outputReportTypes` includes `agent.tool_call_started` and
`agent.tool_call_finished`. Neither changes access. The decision activity check
ignores them while still refusing turn closure, Stop and revoked access. The
regressions inject each type during both model and MCP decisions. Omitting
either type makes those decisions return 403. Approved Ask retries also accept
both types and use the approval once. The server's approvals GET regression
adds each type during its access check and expects 200. Removing the matching
entry from `outputReportTypes` makes that read return 503. Chat and computer
facts catch up before the short access check; only new activity is read during it.

## Conversation closing reads

`history` includes `conversation.closed` records from the participation stream
when reading conversation facts. It sorts both histories by their saved position.
`decisionActivity` includes both close formats in its existing conversation activity read.
It uses the event store's single indexed query and does not read another authority stream.
Its final check reads only new records and treats a close on either stream as a refusal.
The combined query returns no unrelated entity events or participant changes.
Human approval decisions also check newer records on both streams before saving.
They resume from the saved global event position without rereading messages.
Participant changes do not become message activity. Access checks still use their
own member, participant and grant facts. Older closing events remain valid.
The decision, gateway and approval tests write current closes to participation
streams. Projection replay tests also cover the earlier form.

## Decision activity summaries

Model decisions read `decision-grants` through `readStreamSummary` before the
access check. Each model keeps separate maps for member, assistant and team ids.
A map entry keeps only the latest action, event id and sequence as a compact JSON
string. The event id is needed to check that OpenFGA has applied the change.
The action also records whether a team was ever granted access. The resource kind
and id come from the model stream, after each event is checked against that stream.
The cache does not keep the full event or extra fields that cannot affect the
decision. Revocations without `granteeKind` update all three identity kinds.
Previously granted teams remain known after revocation, so delayed OpenFGA updates
cannot keep their old
access usable.

The check reads changes after the global position captured before catch-up,
including changes saved before the access check opened. History and access share
the original two-second request budget. Compared with #198, PR 2b is stricter
in two cases:

- A relevant grant change saved during catch-up refuses the current call, even
  when the summary includes it and OpenFGA has already applied it.
- An older revoke without `granteeKind` refuses the current call if its id was
  ever granted as a team on this model. The team need not own the assistant or
  currently include the requester.

These rules never add permission. OpenFGA still decides whether the requester
and assistant can use the model. Unrelated typed member grants keep working.
The [model API](../../docs/api/providers.md#model-calls-during-grant-changes)
describes these extra refusals for callers.

### Grant memory budget and queue

The grant cache keeps at most 64 model summaries. It has an estimated budget of
16 MiB across one store in one process. Each summary counts as 256 bytes, and each
kind and id counts as a 160-byte record for a UUID id and a compact record of at
most 51 UTF-8 bytes. Longer ids and records add two bytes for each byte above
those allowances. This also charges longer event ids and sequence numbers.
100,000 UUID grantees fit on one model: 16,000,256 estimated bytes. The count is
per kind and id; a legacy revoke can keep three records for the same id.

Whole grant summaries are dropped, starting with those used least recently. A
summary larger than the whole budget is dropped on its own. The next call reads
that model from sequence 1 to rebuild it. More than 64 active models, longer ids
or more than 16 MiB of cached facts can therefore cause repeated cold reads.
The estimate covers retained summaries; it does not cap active reads, caller
copies or complete service memory. No
permission check skips catch-up to avoid a rebuild.

Each model has its own queue. Calls for that model wait for earlier catch-ups,
including a catch-up whose caller has already timed out. Other models have
separate queues. Each live decision's event-store catch-up read has a ten-second
deadline starting when its queue slot runs. The caller still has only two seconds
and refuses when that time runs out. Background catch-up may then continue. A
later call resumes after the last applied event if the partial summary remains
cached. A cold model may need several attempts to finish. Several earlier calls
can make the total queue wait longer than ten seconds. Queued reads are not
cancelled when their callers time out.

A call is refused before holding money if the saved history ends before the
summary's latest position. Processes must restart after an event-store restore.

`test/decision-grants.test.ts` checks that 100,000 UUID grantees stay cached without
full event payloads. `test/decision-cost.test.ts` checks 10,000 members on one
model and another eight models with 1,000 members each in one process. After
warm-up, two rounds of real HTTP decisions use only later grant reads and finish
within two seconds. It also covers 3,000 grantees, 15,000 edits to one grantee,
revocations before and after the summary read, delayed team receipts and restored
history. `test/decision-fence.test.ts` keeps all #198 refusal and harmless cases,
including zero-cent release after an allow audit and disconnection.

`decisionActivity` uses the auth `computer` summary and the models `decision-chat`
summary. The computer facts include the latest lifecycle event and the requested
turn's first start and first close. Admission requires the same Ready position
returned by credentials, no close, a server-owned first start, and matching thread,
conversation, requester and task. A start from another source cannot grant access;
a close from any source refuses it.

The chat summary keeps events in their saved order, except `outputReportTypes`.
A posted message keeps only `{ conversationId }` in its data. No decision reads
its encrypted text. Each call copies rows up to its captured log position. The
unchanged `confirm()` checks later activity, including approval invalidation.
The shared two-second budget, disconnect check before reservation, watched access
streams and all existing refusal rules remain in place.

The kind keeps at most 64 chats with a 72 MiB estimated memory budget. Each kept
row counts as 1,152 bytes, above the measured UUID row cost of about 1,009 bytes.
This allows 65,536 kept rows: two 10,000-turn chats with creation, message, start
and completion events fit together. Reply chunks do not count because this
summary does not keep them. The shared computer kind has a separate 48 MiB
estimate. Together these allowances use 120 MiB of the 256 MiB heap cap. Model grant
summaries add a separate 16 MiB estimate, leaving 120 MiB for other service work,
caller copies and active reads.
Whole summaries are
dropped in least-recently-used order; individual refusal facts are never removed.
A dropped summary rebuilds from sequence 1. A summary larger than its whole budget
is dropped on its own, leaving other chats warm. Later calls may time out rebuilding
that summary. These are estimates for retained caches, not limits on peak memory
during concurrent reads or complete service
memory. More active streams than the cache can hold can cause repeated rebuilds.
No permissions check skips a catch-up to avoid a rebuild.

After an event-store restore, the server and models processes must restart before
serving requests. Each decision also reads both subjects' latest positions after
copying summary facts, within the original shared two seconds. A position below
its summary's position refuses the call before reserving money. This catches a
restore only while the stream remains below its old position. New events can
pass that position again, so the guard cannot replace the restart. The restart
is part of the restore drill. `confirm()` and its watched subjects are unchanged.

`test/decision-cost.test.ts` drives real HTTP model admission at 10, 100 and 500
older turns with 10 and 3,000 chat events. It counts credentials, activity, access,
reservation and audit reads together. The 500-turn count and long-chat count may
exceed their short equivalents by at most two rows. It also checks cold catch-up,
fresh suspension or closure, start source and all turn bindings without new holds.
The cold catch-up test pauses the first chat read until admission times out, then
waits for that read to finish before checking a new admission on later rows.
A separate real-gateway test delays a saved allow record beyond two seconds.
It checks the 503 refusal, no provider call, the earlier reservation still held,
and a zero-cent `not_dispatched` settlement for the refused call alone.
It also checks that restoring either subject below its summary refuses another
call without holding more money.
`test/decision-activity.test.ts` checks warm reads, removed output/text, saved order
and the captured position. It also checks that an oversized decision summary is
dropped and retains old approval activity when rebuilt. Two 10,000-turn chats
with 600 replies of 300 chunks each stay on tail reads. Existing fence, authority,
gateway and shared-assistant
tests retain their original security checks.

### Decision chat memory measurement

The synthetic reader in `test/summary-memory.ts` supplies a posted message, a turn
start and a turn completion for every turn. Each message carries a distinct
32,000-character ciphertext placeholder. Source rows are not kept by the reader.
Ids are 36-character UUIDs. Events include request, conversation and turn
correlation ids, with strings copied as on decoding. Node 22.23.3 uses `--expose-gc`
and a 256 MiB heap cap. Collected heap with and without the store gives retained
cache bytes, excluding loaded packages. Heap is sampled every 100 rows and at the
end of the build, before the final repeat read. Shorter peaks can be missed.

| Shape | Retained cache bytes | Total heap bytes | Sampled peak heap bytes |
| --- | ---: | ---: | ---: |
| One chat, 10,000 turns, unbounded | 30,275,336 | 64,426,712 | 89,749,528 |
| Two chats, 10,000 turns each, budget enabled | 60,547,128 | 89,576,120 | 113,902,064 |
| 64 chats, 10,000 turns each, budget enabled | 60,546,592 | 89,011,352 | 191,209,456 |
| One oversized chat, 23,000 turns, budget enabled | 3,248 | 27,929,664 | 129,964,440 |

The two 10,000-turn chats stay warm. The 64-chat run keeps two chats; older ones
are dropped. The oversized chat keeps no summary and rebuilds next time; its peak
includes that full build before dropping it. These figures measure one kind at a
time, without simultaneous catch-ups or a live models service. The computer
measurements are in the auth README.robot.md. The server chat kind uses its own
32 MiB estimate and counts compact report positions separately.

A repeatable command from the repository root is:

```sh
nice -n 10 npm run measure:summaries:memory -w libs/models -- chat 2 10000 1
```

Arguments are kind, number of streams, turns per stream and turns per thread.
The last number matters only for computers. Add `unbounded` to disable the memory
budget in this measurement; it does not change a running service's settings.
Use `chat 1 23000 1` for the oversized rebuild.

`NODE_DEBUG=opencrane-summary` logs each rebuild from sequence 1. Larger active
working sets remain tracked in #256. The remaining
whole-log report and approval reads are tracked in #253, #254 and #255. These
sites are outside this change. Fresh-install qualification remains in #63.

## Codex tool request fixtures

The MCP schema uses Codex 0.159.2's camelCase metadata keys inside `params`.
It requires `threadId` (1–200 characters) and `callId`, checked with
`isToolCallText` from the events package. The call id has 1–200 characters and
contains no Unicode control, format, surrogate, private-use or unassigned
characters. Unsafe ids are refused before they can enter a decision event.
The thread must match the signed turn. When present,
`x-codex-turn-metadata.thread_id` must match too. Unknown metadata fields are refused. Client capabilities are an object with at most 32
entries and 16,384 JSON characters. Turn metadata allows at most 32 scalar entries.
Client info and progress strings are at most 200 characters. Session and item ids
have 1–200 characters; window ids have 1–402. Turn metadata strings are at most
2,000 characters.
Argument numbers keep their original text. Duplicate keys are refused.
History catches up before the two-second access check.

`test/fixtures/codex-0.159.2-tools-call.json` copies the saved 6 October 2026
wire capture. Its bearer presence marker was removed; it contains no credential.
`codex-0.159.2-follow-up.json` is the full follow-up body captured on the same date
from computer image `127.0.0.1:5001/opencrane/computer:p317` (image id `sha256:5cfe0d46972df36f2a2b3d2a6b09b78c10944ba8f6233b687a9501ed1dc58e1c`).
The image reported `codex-cli 0.159.2`. The saved probe was changed only to retain
each model body rather than shorten its input, then run with:

```sh
docker run --rm --network none --entrypoint sh \
  -v /tmp/p3-5-pr2-probe.mjs:/tmp/probe.mjs:ro \
  127.0.0.1:5001/opencrane/computer:p317 \
  -c 'codex --version >&2; node /tmp/probe.mjs flag never'
```

Both servers were local stubs inside this disposable container. No paid model
was called. The model-route test changes only `probe-model` to the signed model
and adds the required output cap. The fixture itself is the complete captured body.
It proves the optional function-call `namespace` (at most 200 characters) and
string or text-array function output. Extra item fields remain refused.

### Caller-supplied call ids and the computer proxy

The signed turn token identifies the thread and turn. It has no call id or tool
name claim. The decision service therefore cannot prove that a call id belongs
to a particular Codex call. Adding a tool name to a decision would still let a
forged request reuse the id with the same tool.

The backend spec, section 3.4 steps 1 and 4–5, assigns caller authentication and
forwarding to the computer proxy in PR 4. That work must prevent a shell process
from choosing another live thread or call id before the browser relies on the
`turnId` + `callId` join. It needs a test where one call is refused and a forged
Allow request in the same turn reuses its id: the forged request must not add an
Allow row to that call. Legitimate Ask retries must still keep several decision
rows for the same call. The computer image wire check now runs this refusal as UID 1001 against the real proxy.
It gets 401 before reaching the gateway and cannot read the caller file or use its
control socket. The caller check must stay in place for this join to be trusted.

The credential-free computer route keeps `_meta` unchanged. Odoo metadata handling
remains a separate decision before #53.
The session, window and nested session ids do not decide OpenCrane access here.

### Repeated tool-name headers

The MCP route uses HTTP `extAuthz`. agentgateway v1.5.0 copies only the first
value of each listed request header in that protocol. `addRequestHeaders` therefore
sets the decision request's `mcp-name` to all supplied values, joined with commas.
The existing comparison with the body then refuses duplicates, including repeated
identical names. No refused request reaches the tool server. Valid single-header
requests still keep their original body bytes and public headers.

## Member reads

`readActiveMember(..., requiredRole = 'member')` checks events, ownership and IAM once.
`'admin'` requires Owner/Admin; reads use no `authorityFence` or conversation activity.
`readActiveMember` and `groupMembership` accept an optional last argument that checks
whether OpenFGA has applied a saved event. Memory reads use it to avoid asking about
the same event twice in one request. The next request checks again. Other callers
ask OpenFGA directly; spending and write deadlines remain unchanged.

## Confirmed tool refusals

The decision service adds `x-opencrane-decision: refused` to its 402 and 403
answers, including the error path. MCP backend reply policies remove this header
from tool-server replies. They do not run for an authorisation refusal, which
never reaches a backend. The computer proxy forwards no caller-supplied marker.
`test/gateway.test.ts` checks both paths with the real agentgateway: a refused call
keeps the marker with no upstream call; an allowed call whose tool server forges
the marker loses it, while its status and body stay unchanged. A malformed tool
call checks the decision error path too. The marker proves refusal before sending;
a body or `x-request-id` alone does not.

## Allow-only turn tools

The computer proxy sends `x-opencrane-tool-mode: allow` from the turn's saved tool
mode, rather than accepting it from the caller. The gateway forwards the header to
the decision service. If the current policy is Ask, `mcpPolicy` returns a
`policy_block` denial before any approval card is created. Requests without the
header keep the existing Ask flow. Unknown and repeated mode values are refused.
The real gateway test covers Allow changing to Ask with no new tool request or
`tool.approval_requested` event. No paid model call is made.

Invitation acceptance reuses `authorityFence` and `currentMembership`.
Their store arguments accept the read methods they use, allowing the server's
join command to keep its small store contract. `history` and membership reads
need `readStream`; the access check also needs `head`. Their behaviour is unchanged.

## Waiting tool calls

Computer Ask calls (`x-opencrane-tool-mode: ask`) create approvals with a 15-minute
expiry. Retries carry `x-opencrane-approval-id` through the gateway and may consume
only that approval. A changed approval or an Allow policy refuses the retry.

A retry carries the approval id from its first call. The decision service computes
that id from the current tool review, arguments and turn before writing anything.
A mismatch is refused and creates no approval card. The existing approval remains
bound to its original action.

Approval card reads accept an inclusive `fromSequence` from the caller’s current join.
`readApproval` also returns `requestPosition`, so decisions can refuse an older request.

Approval reads also return `conversationPosition`, the last conversation record checked
for request invalidation. `decideApproval` requires those checked facts from
`readApproval`. It checks only later records and the current tool policy, confirms the
small access streams, and checks later activity again before its conditional append.
The append expires with the access deadline. The server reads the review before that
short check, so older messages cannot consume it.

## Historical computer losses and initial model grants

A saved `computer.lost` changes held money only while it remains the latest computer
lifecycle event. It applies only to reservations saved earlier in the event log.
A newer reservation or a later claim makes the old loss a no-op. SQL handler receipts
still record successful no-ops. Event positions, rather than clocks or reused
computer ids, establish which reservation came first.
Initial model grants check current membership for people and personal assistant
owners. Removed members get no grants from older creation events. Existing grants
and revocations remain unchanged. Tests are `actor.test.ts`, `loss-backfill.test.ts`
and `grants-backfill.test.ts`; settlement history remains covered by `reconcile.test.ts`.

Provider bindings read history before the two-second authority check and make one category-conditional append with `historyChecked`. Moves require both creation receipts, manage permissions and reviewed revisions. The default reaction never replaces a recorded choice or pause. Ordinary-call activation remains unavailable.

Binding commands find saved ids across actors on the same provider. Actor or request
changes return a conflict. After append, `readEventAt` checks the stored event before
returning its receipt, including duplicate recovery. The automatic default calls the
private binding command with `system:seed-provider-default`; public command schemas
reject its colon. Only automatic selection follows the first verified provider.
Explicit initial choices can use any eligible connection.

`apps/server/test/provider-binding-guards.test.ts` covers concurrent same-id requests,
actor reuse, the reserved reaction id, explicit initial defaults, independent source
and target access checks, key references, registry support, access rechecks, history
ordering and changing reads, pause preservation, replay and status reads after role loss.
It uses disposable NATS and OpenFGA plus PostgreSQL with `PG_TEST_URL` set.

The shared provider append helper reads the event at the returned position before
returning a receipt. It checks the silo, subject, command id, actor, event type and
request data. A binding and a configuration request that reuse one command id
cannot both report success. The request for the other operation returns a conflict;
status GET reports the operation that was saved. A missing saved event refuses the
receipt as unavailable. This check also applies to verification records.

The binding guard tests cover both save orders with an append barrier, status
recovery, retry access expiry and revocation, failed appends and individual saved
event identity checks.

## Memory recall capabilities (P4-12 PR 3a)

Only `/mcp/memory/server` receives signed `x-memory-context` from the shared dispatcher.
Before issuing a pass, ext_authz checks
live turns, requester/assistant `mcp_server` grants, and Allow recall policy.
Recall also requires current `memory_read` grants for its selected scope.
Claims bind silo, requester, assistant, computer/generation, conversation, turn, thread,
operation, selected scope, private content class, call/decision ids, body digest and event position.
`dispatch` binds the pass SHA-256 digest, backend generation, schema digest and policy revision.
The backend compares the signed revision with current policy and the generation with its
configured instance. It consumes each pass digest once, before any asynchronous rights check.
Its bounded process-local cache retains consumed digests until expiry. Contexts issued before
that backend started are refused too. The dispatcher also consumes every pass before checking
it, including refused attempts. Neither process retries a consumed call.
The server verifies ES256, issuer, audience, expiry within two seconds and body/thread binding,
then rechecks live rights and policy. Only an explicitly recorded `restricted` turn is allowed.
Legacy starts without a mode, `memory_free` starts and shared-only contexts are refused.
Both `memory_read` and `mcp_server` need current recorded `grant.given` events for
the requester as `member` and the assistant as `assistant`, as well as OpenFGA permission.
For memory reads by a team assistant, a recorded `team` grant to its owner group can
also supply requester rights after current recorded membership and OpenFGA membership checks.
A revocation without a kind removes both matching identity kinds. Leftover OpenFGA
permissions and grants for another identity kind cannot replace these recorded grants.

### Notes and group recall (P4-12 PR 3b)

Choices come from the server-recorded assistant: the requester's person scope,
the bound assistant's notes, and a team assistant's owner-group scope. Another
group membership or another assistant owned by the requester cannot expand this list.
A personal assistant must belong to the requester. A team assistant requires current
recorded owner-group membership and OpenFGA permission, including for personal recall.
Inactive assistants and pending membership removals refuse before any fact query.
Only small assistant, member, team and grant streams supply these access checks.

Discovery and listing need the recorded MCP grants and current live audience, but
do not read facts or require a personal memory grant. Recall checks the selected
scope's operation grants separately at both gateway and backend admission.
Remember remains unadvertised and refused, including private calls with plausible
shared source references. Native turns still receive no memory tools.

The earlier recall-only work was built before the personal command path merged.
Personal remember now uses that path, as described below. Server-recorded shared-only
execution and shared agent writes remain separate work. A caller's `shared_only` claim
is still refused; shared execution input isolation is not established.

Review follow-ups now cover fractional-second expiry, independent discovery
version/name headers, and the issuer's two-second cap and shorter caller deadline.
Reversed lifetimes also fail through future issuance or expiry; that check is redundant.
The remaining snapshot-filtering and independent recorded-identity/closure guard
cases from verify1 remain follow-ups. The earlier qualification limits below still apply.

Source checks on 9 October 2026: PASS for `npm run lint` (including Knip),
`npm run typecheck`, `npm run check:events` (99 types) and `npm run lint:changelog`.
Both five-file targeted runs passed 164 tests with `PG_TEST_URL` set. An additional
MCP-only run passed 34 tests after revocation checks gained fresh signed passes.
Final checks of the changed TypeScript files and the models package also passed.
All lint, typecheck and Vitest commands used `nice -n 10`. Dependencies were installed
with `npm ci`; NATS and Lychee use the requested shared-tool symlinks.
The test commits precede implementation. The full root suite and live fresh-install
qualification are NOT RUN. PR #299 was still unmerged at this receipt, so this branch
uses its source and needs rebasing onto main after it lands.

### Review correction evidence

The regression tests were committed in `692b5c0e` before the fix in `4cadf010`.
The real-service run returned HTTP 200 for both an absent recorded memory grant
and a legacy mode-less turn, where HTTP 403 was required. Both now refuse before
any fact query. The successful fixture records `restricted` explicitly.

`test/memory-context.test.ts` checks a well-formed wrong-key signature, issuer,
audience, algorithm, required and bounded claims, lifetimes, independent request
bindings, strict recall arguments and request limits. `apps/server/test/memory-mcp.test.ts`
checks backend identities and starts, current permissions and revocations, missing
keys, concurrent access and activity changes, the original deadline, the complete
thread proxy → real gateway → backend call and model header removal.

The global `contextPosition` is recorded in the signed context. It is not a
content-context generation or a set of per-grant positions. Current recorded
access is checked again at both admission points. Network isolation of the backend
and fresh-install journeys remain NOT RUN. A matching signed context can be used
directly at the backend while it is still valid. This does not establish complete
section-3 qualification of the memory specification.

Final checks use `nice -n 10`. The targeted tests run twice with
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`:

```sh
npx vitest run apps/server/test/memory-mcp.test.ts libs/models/test/memory-context.test.ts apps/server/test/memory.test.ts apps/server/test/turn-tools.test.ts libs/auth/test/tokens.test.ts --maxWorkers=1
npx vitest run libs/models/test/codex-mcp.test.ts -t 'forwards captured Codex bytes' --maxWorkers=1
```

These runs cover 157 tests and one selected external MCP test per run. The full
root test suite and live fresh-install qualification are not part of this correction.

## Provider turn contracts before activation

P4-22 row 4 is split. This first change records and signs provider identity and
preserves it in reservation replay. `turnSchema` requires `providerId` and positive
`bindingSequence`. The separate legacy parser remains available before switch-on.
Any token supplying either field must pass the required schema. Admission compares
both fields and any recorded model with the first `computer.turn_started`.
Ordinary model calls with provider claims are refused before any hold, including
when they match the recorded turn. The gateway still uses the deployment key.

Remaining work: migrate with separate resumable commands and build a switch-on
command that cannot strand running turns. Managed dispatch
also needs the real gateway proof and provider/key checks from row 5. There is no
switch-on command or retirement in this first change.

`test/provider-turn-contract.test.ts` uses real NATS, PostgreSQL, OpenFGA and the
pinned gateway with a recording upstream. It checks zero holds and sends for bound
or incomplete tokens, unchanged legacy traffic, matched issuance and reservation
replay with the original cents and tariff. Set `PG_TEST_URL` to a disposable server.
Fresh-install migration, paid calls and retirement remain NOT RUN.

`test/provider-turn-guards.test.ts` checks a signed pass with both provider fields
missing from a bound turn. It also checks each provider, position and model mismatch
before the later managed-call refusal. Malformed claims must fail before the
decision checks the turn's recorded activity. Issuance must refuse a changed task.

`test/provider-turn-replay.test.ts` feeds incomplete provider pairs straight to
budget replay, without using append validation. A real NATS test records usage
with a non-zero cost, delivers it twice, restarts the budget actor and delivers it
again. It checks one saved settlement and unchanged provider, model, payer and
price-table fields. It sends no provider request.

`currentMembership` accepts a separate history deadline for reads before a write access check.

New owners need `member.ownership_confirmed`: see the [ownership contract](../../docs/api/ownership.md).

`currentMembership` reads only the named member and ownership streams. It returns
that member’s role and the events needed to check their access. Pending appointments
need the matching confirmation in that member’s stream. `currentOwnershipMembership`
reads each other successor once to calculate the complete owner set. It keeps
historical successors out of the positions used for write access checks. Their
later ordinary role changes cannot remove ownership.
`activeMember` can reuse a membership read completed before the write check. It
compares both saved stream positions before checking current permissions and
applied receipts. A position change or an expired two-second window refuses the write.
When a caller has already started its write check, membership reads use that same
deadline. They never start a new ten-second history window.

## Recorded tool failures and approval actions

The [approval API](../../docs/api/approvals.md) explains tool failure records and approval actions.

## Personal remember admission

The signed capability can name `remember`. Its scope stays the requester's person scope.
Group and assistant-notes writes return `agent_person_scope_only` even when grants and
shared recalled references are valid. Both requester and assistant need recorded `memory_write` grants and current OpenFGA rights;
a read grant cannot supply write permission. Ask and Block policies refuse the write.
Discovery omits remember until trusted records cover every loaded fact reference. Recall-only
installations keep working without a remember policy.

`memoryRights` returns a final check that reads saved grants, current permissions and tool
policy again. It reuses the conversation history already read. The server calls it before
the conditional append, with the capability's original deadline.
For remember, repeated checks retain the original `decisionAuthorityFence`. They refuse
relevant access changes even when a removed grant has already been restored.
The returned `writeAuthority` gives the server this same check and its original deadline
for the store's `checkAccess` option. It watches the assistant, member, grant and relevant
team streams already selected by the rights check; no conversation stream is added.
Reads still
take a fresh access snapshot. Neither path adds conversation history to the access check.
It uses the dispatcher's `confirmDecisionAccess` loop. Access and later activity
checks repeat until both see no new events. A harmless admission cannot hide a
revocation saved while it is read. The original deadline still ends the check.
It watches small access streams and checks later turn activity separately. It does not add
conversation or memory-content streams to the access snapshot. The server's signed recalled
references and command checks are described in `apps/server/README.robot.md`.

## Shared child records

`conversationParticipation` builds initial joins from a parsed creation record.
`conversationHistoryPosition` returns child creation for shared history and the current
join for other chats. Authority still uses the current join. Neither helper reads history.

## Private turn memory preview

`memoryRights` returns a `confirm(deadline)` function for preview reads. It checks saved grants, current permissions and tool policy again using the conversation history already read. The final short check never reloads that history. Turn starts do not grant access or refuse a memory read.

## Memory reference validity

`memoryReferences(rows, silo, scopeId, custody, checkedAt?)` checks metadata and key status without
reading fact text. It keeps the first metadata for an equal revision, as the projection does.
It reads version-1 corrections as replacements, retaining all historical dependencies.
It refuses cycles and keeps legacy corrections or
tombstones unusable. Missing or damaged custody raises an error. Private turn previews omit
references that cannot be checked. Discovery offers recall only until trusted records cover
every loaded memory reference.
The optional `checkedAt` is a timestamp in milliseconds for nightly selection at its
intended boundary. Other callers check the current time on each `current` call.
Revision selection uses the same `shouldReplaceMemoryRevision` rule as the projection
and nightly scanner. The scanner supplies metadata-only custody because it opens no keys
and dispatch stays disabled; live readers still use real key status.

## Turn admission after the recorded switch-on event

`provider-turn-routing` keeps the current binding for each dependant and task,
while `provider-call-mode` keeps the silo's switch-on marker and latest personal
paying group from `budget-<silo>`. Admission uses both facts from the same
incremental read. Its final mode check reads only later budget rows, so an ordinary
personal start reads each new budget row once. It never reads the whole budget
stream or uses a wildcard for budget facts.
The routing summary reads new provider events before new-turn admission;
it does not retain the full history. Turn admission reads it before the short
payer check. An own binding, including a pause, takes precedence over the default.
Before the marker exists, saved choices do not alter ordinary traffic.
The decision service requires both provider claims after the marker exists.
It rechecks mode before reserving money and returning a permit. Other provider
configuration changes do not invalidate unrelated calls. Provider-bound model
calls still refuse on the deployment-key route, so they cannot spend on its key.
The managed-only gateway, startup fallback-key refusal and safe switch-on command
are not built in this slice. This marker has no production command or reaction.
`apps/server/test/provider-turn-admission.test.ts` checks selection, pause precedence,
missing choices and original choices on replay and closure. The provider contract
test checks old-token refusal through the real gateway before any hold or send.
Fresh-install migration and managed dispatch remain NOT RUN.

## Exact streams during model decisions

Model decisions read mode from the exact silo budget stream. They never read the
provider category. They load chat, computer and mode history before starting the
short access check, then read only new activity before reserving and returning a
permit. A provider-bound pass must match its recorded turn and still refuses on
the deployment-key route before holding money. Switching on advances the budget
stream, so an old budget writer cannot append a reservation across that change.
If only switch-on records followed its last position, the actor moves past them
and retries a settlement or another budget change once. It refuses new holds,
including after replay, without stopping releases, expiry or later settlements.
Any change from another budget writer still stops the old actor. It reads only
events after its saved position when checking an append conflict.
Retrying a spending-limit change checks the caller's access again within its
original deadline. A refused change does not stop settlement of existing holds.
The actor compares the client's expected revision with `state.sequence`, the last
budget event shown in replies and the projection. Its private `sequence` includes
switch-on records and is used for conditional appends. Skipping a marker changes
only that writer position. An access-expired limit change or a refused reservation
therefore leaves the reported revision valid for the next spending-limit change.
A saved budget event advances both positions and makes an older client revision
conflict. `test/actor.test.ts` checks retries with the projected revision, with and
without an open hold, and after switch-on refuses a reservation.
A decision audit uses a fresh command id and `historyChecked: true` against zero.
No earlier event can share that new command id.

## Recorded draining before managed calls

P4-22 row 4d is the first split of the remaining migration work. It provides
`GET` and `POST /api/org/providers/:providerId/drain`. POST accepts `commandId`,
`action: start | cancel`, `expectedRevision`, `expectedProviderSequence` and
`expectedDrainSequence`. GET supplies both positions, the current revision,
`draining` and `enabled`. Both operations require current Owner/Admin membership,
provider management permission and the applied provider creation receipt. POST
also requires the trusted Origin. Status uses the existing changes GET URL.

Each command makes one conditional append to `provider-*`. A same-id retry returns
the original receipt, even after cancellation. Changed arguments or a different
administrator conflict. A stale position or revision conflicts. Configuration
history is read before the two-second access check. Cancel writes a new event;
it cannot undo switch-on or return managed traffic to a deployment key.

The recorded drain stops new turn admissions and is checked again after payer
reads. Already recorded turns can renew passes, make more calls and close through
their original path. Spending checks and settlement keep the original payer,
model and tariff. Switch-on ends draining when its event is replayed.
The drain has no timer and no process-local setting. Replaying
provider events restores it. Calls do not append provider events.

Migration preparation reuses separate commands: create an explicitly named
connection; save its existing key through secret custody; select its existing
models; record explicit silo default task bindings. Each command has its own id,
receipt and status read. A failed step resumes by that id; it does not repeat earlier
steps or alter grants. An automatic first-provider default is not proof of the
old deployment key's identity. The operator must record the intended choice.

The safe switch-on command below now checks legacy turns and migration choices.
A pending legacy admission can still append later, but cannot reserve or send after
switch-on. Concurrent reservations refuse switch-on. Managed gateway startup,
fallback-key refusal and switch-off remain unbuilt. Retirement remains unavailable.
Fresh-install migration and managed dispatch are NOT RUN.

Source receipt, 10 October 2026: `fe7bf89d3113cdac4f446f8c6aa9bf7d9634c085`.
Linux worktree after `npm ci`; disposable NATS, PostgreSQL and OpenFGA;
pinned gateway with a recording upstream. This is not a fresh customer install.
PASS: all three changed test files, twice, 42 tests each; `PG_TEST_URL` set.
PASS: full lint, root typecheck, Knip, event catalogue and changelog checks.
Logs: `/tmp/p4-22-pr4d-final-pass-{1,2}.log` and `/tmp/p4-22-pr4d-*.log`.
NOT RUN: full root suite, fresh-install journey, paid calls and independent review.

Drain writes also check `expectedGlobalSequence`, captured before reading history.
This keeps switch-on on the budget stream from racing the drain append. Other new
events cause a conflict and require a new status read. Draining remains on provider
streams, so already running legacy calls can still hold and settle money. Switch-on
on the spending stream always ends draining.

## Restack checks after the exact-stream correction

Date: 10 October 2026. Source: `1db16002b7c711172d6eeec5420985845e88bad0`.
Replayed only the four original drain commits onto `47cd8db0` from
`work/p4-22-pr4c`. The rebase finished. Kept both the mode and drain tests,
alongside the merged role, group-participant and memory documentation.
Environment: Linux, Node 22, local worktree, disposable NATS and OpenFGA,
PostgreSQL test server at `127.0.0.1:55432`, and a recording gateway.
This is not a fresh customer install.

PASS: all three changed test files and both unchanged authority files. Also ran
`libs/event-store/test/history-checked.test.ts`. The first six-file batch had
65 passes and one payer-race fixture failure. Updated its trigger to wait for
the payer read after the mode read; all 13 tests in that file then passed.
All 66 distinct tests passed across these runs. The authority guards passed once.
The new race test saves switch-on immediately before the drain append, gets a
conflict and checks that only the switch-on event was saved. Running legacy calls
still settle their original charges during drain.

PASS: changed-file ESLint, root typecheck, event catalogue (101 types), Knip,
changelog, dependency direction, Markdown and offline links. Tests set
`PG_TEST_URL`; tests and source checks use `nice -n 10`.
Logs: `/tmp/p4-22-pr4d-restack-tests.log`,
`/tmp/p4-22-pr4d-restack-admission.log`,
`/tmp/p4-22-pr4d-restack-lint.log` and
`/tmp/p4-22-pr4d-restack-typecheck.log`.
NOT RUN: full root suite, another full root lint on this restacked branch,
paid calls, independent review and fresh-install migration qualification.
The base branch's full lint passed before the restack.

## Checks after the settlement correction

Date: 10 October 2026. Source: `ed645fb6cd922f5421b4a0a279f02fa9d8b31bb7`.
Replayed only this branch's seven commits from `c38546b3` onto `00da8fde`
from `work/p4-22-pr4c`. The rebase finished. Compared the old and new commit
ranges: the drain code is unchanged. Conflict resolutions keep main's approval
notes, the parent's settlement tests and this branch's drain tests.

The actor and its tests match the fixed parent. Both authority files match main
and are unchanged. Holds saved before switch-on can settle, release or expire on
the same actor. Draining still records no budget event and leaves running calls
on their original path.

Environment: Linux, Node 22.23.3, local worktree; disposable NATS and OpenFGA,
PostgreSQL at `127.0.0.1:55432` and a recording gateway. This is not a fresh install.
Tests set the documented test-only `PG_TEST_URL`, use `nice -n 10` and one worker.
The event catalogue check passes with 104 types.
PASS: one six-file batch passed all 69 tests. It ran all three changed test files,
both unchanged authority files and `libs/event-store/test/history-checked.test.ts`.
The 100,000-event authority guard and the switch-on settlement races passed.
PASS: root typecheck.
PASS: full root lint, Knip and changelog checks. Lint reports 15 existing warnings
and no errors. No production code changed after these checks.

Logs: `/tmp/p4-22-pr4d-settlement-restack-tests.log`,
`/tmp/p4-22-pr4d-settlement-restack-lint.log`,
`/tmp/p4-22-pr4d-settlement-restack-typecheck.log` and
`/tmp/p4-22-pr4d-settlement-restack-events.log`.

NOT RUN: full root suite, paid calls, fresh-install managed-provider qualification
and another independent review. The switch-on command and managed gateway remain
unfinished.

## Restack after the spending-limit revision fix

Date: 10 October 2026. Restacked source: `59931d5f`.
Replayed only this branch's eight commits from `00da8fde` onto `0199abaa`
from `work/p4-22-pr4c`. The rebase finished. README diagram conflicts retain
main's member-access description, the parent's spending-revision description
and this branch's draining description. Production additions and removals match
the previous drain branch at `5e99e5d5`.

The actor and its tests match the fixed parent. Both authority test files match
main and remain unchanged. The parent's narrow money verification returned LAND.
No new money behaviour is added by this restack.

Environment: Linux, Node 22.23.3, local worktree; disposable NATS and OpenFGA,
a recording gateway and PostgreSQL at `127.0.0.1:55432`. This is not a fresh install.
PASS: all three changed test files, once, 48 tests. The run sets `PG_TEST_URL`,
uses `nice -n 10` and one worker. PASS: event catalogue (105 types), changelog
and Markdown checks. The fixed parent passed full lint, typecheck, Knip and both
seven-file test runs, including the unchanged authority files.

Logs: `/tmp/fix-307c-restack-314-tests.log`,
`/tmp/fix-307c-restack-314-events.log`,
`/tmp/fix-307c-restack-314-changelog.log` and
`/tmp/fix-307c-restack-314-docs.log`.
NOT RUN on this restack: another full lint or typecheck, full root suite,
paid calls or fresh-install managed-provider qualification.
The switch-on command and managed gateway remain unfinished.

## Private connection custody (P3-8 PR 1)

`src/connection-custody.ts` stages immutable Opaque Secrets through a private loopback
`kubectl proxy`. It accepts one namespace, private HMAC keyring and shared private journal
directory. Names identify the silo, installed connection, profile and generation. Labels also identify
the user, server and purpose. A keyed check (HMAC) covers those fields, the operation id,
expected sequence, deadline and material. Retain older
key ids while their generations exist. Results contain only status and exact identity.
`connection-stage-journal.ts` reuses exclusive 0600 provider-file writes, then flushes files
and their directory. It stores the operation id, reference, expected sequence, deadline and first UID and version.
A separate create claim is flushed before POST. Only its first writer sends the create.
If the reply is lost before the UID/version is saved, recovery returns `conflict` unless
an exact identity from an independent create reply is supplied. Matching bindings,
material and HMAC alone never establish the original UID. A retry never sends another
create, even when the original object has disappeared.

The journal stores no material or verifier and cannot activate a connection. Deletion
checks stored contents and sends both UID/version preconditions. It saves the exact
identity for the deletion check before DELETE. `deleted` requires a later GET returning
404. A finaliser can leave the token readable after a successful DELETE; that returns
`unknown`. After restart, a pending deletion checks absence first. If the original object
is still present and its exact identity and bindings verify again, DELETE can retry with
the original preconditions. A changed version, including a finaliser change, is never
adopted. Conflicts and unknown outcomes retain material. A 404 never proves failed activation. The candidate reconciler described below requires
a conflicting profile event to prevent late appends before cleanup. No routes, event writes or material releases are registered.

Checks adapt OC1 commit `10abd0ef6`, `kubernetes-mcp-connection-secret-store.ts` and
`mcp-connection-material-verifier.ts`. [The original AGPL-3.0-or-later notice](src/connection-custody.NOTICE)
is retained. No dependency was added. [The accepted design](../../docs/specs/phase-3/p3-8-p3-9-personal-connections.md)
owns the plan. Tests use synthetic material and a local HTTP fixture. Live Kubernetes,
custody-only namespace permissions, encryption at rest, backups, restore, power-loss and
fresh-install journeys remain NOT RUN. Deployment wiring belongs to later work.

## Budget stop state (P3-14 PR 1, part of #55)

The actor and projection share one fold. `limits` keep relevant configuration
ids when values are repeated; `stops` keep ids, positions and all reasons.
`stoppedWork` keeps known conversation/turn ids and their first stop reference.

Fitting holds can fill a limit. An over-cap bound saves all failed limits in one
exhaustion event. Zero or a lower ceiling at/below spent-plus-held money stops
at the single configuration append. Settlement and unrelated edits recover
nothing. Only a changed relevant ceiling or its UTC reset permits new work.
Old stopped turns stay refused after replay. Legacy global exhaustion covers
both daily and monthly limits because old records cannot distinguish them.

`reserve` saves a newly refused conversation/turn under an existing stop with one
`budget.exhausted` append carrying `{ stopId, work }`. It uses the current expected
sequence and rechecks access before writing. It adds no history reads and creates
no new scope stop. Repeated refusals of a saved identity append nothing. The fold
requires that stop id to exist, keeps the first reference and restores it on replay.
`budgetStopId` returns that reference for saved work or the active stop for new work.

Refusal messages use the reasons under that stop reference. They name the silo's
daily or monthly cap, the paying group's cap or the assistant's cap. Several caps
appear only when those saved reasons apply to the refused work. A recovered limit
does not change the reason shown for an already stopped turn. The real-NATS tests
in `test/budget-stop-message.test.ts` check these messages and their saved reasons,
including zero ceilings, several causes, unrelated work and replay after recovery.

`reserve` and `admitDispatch` check stops in the actor queue. Admin summaries
include saved stops and known turns. Rebuild projections on upgrade.
The shared final gate covers models, tools, memory and provider verification checks.
Cancellation, queued messages and participant notices follow later.

`test/budget-stop.test.ts` proves isolation, lowered/zero ceilings, relevant
recovery, unchanged edits, settlement, rollover and replay with real NATS. It also
checks refusal persistence without reads, access rechecks, stale-writer conflicts,
both configuration/reservation orderings and the first assistant ceiling boundary.
`libs/events/test/budget-refusal.test.ts` checks the strict stop-reference shape.
`apps/server/test/integrations.test.ts` checks its PostgreSQL rebuild and admin read.

## Pending computer control

`decisionActivity` includes a copied control summary. Initial model, tool and memory
admission refuses pending control. Its bounded activity check detects intent
arriving during authority checks, without reading the whole computer stream as an
access subject. `approvalActivity` shares the turn and control checks for approve
and retry. It does not read spending history or provider mode. Model and memory
admission keep their provider-mode checks through `decisionActivity`; this split
does not change their money checks. Explicit denial remains allowed. Tool and memory
sends also pass through the budget actor before tool-rule admission.
Memory discovery checks recall once and uses the same checked catalogue to decide
whether to list remember. `toolDecision` supplies the existing review, mode and zero-cost
rules for both. The backend repeats its own access check; write confirmations still
read current policy. The slow-read regression keeps the original two-second lifetime.

## Exact tool review

`reviewToolPolicy` accepts one exact catalogue and all tool choices. It reads the server
history once before the two-second membership check. It conditionally appends one
`mcp.server_reviewed` event. Saved retries compare the event type, actor and full input.

## Personal instance commands and reads (P3-10 PR 2, first part)

`mcpInstanceCommand`, `mcpInstanceStatus` and `mcpInstanceChange` take the checked
binding/member separately from an exact instance/profile/server reference.
Saved starts use `startupAccessGeneration`, the positive integer version of the
profile's startup access material. The fold checks it as part of the fixed instance id.
They read only that instance before checking current membership. Reads use
`readActiveMember`; writes use `authorityFence` over small membership streams and
one conditional append to the instance. No conversation history is read or watched.
Stop binds the expected sequence, run and original start. An unchanged retry returns
its original receipt even after a later run. Changed payloads conflict.
After an append, the command reads the returned position and checks the saved silo,
subject, command id, event type, principal and exact stop payload before returning a receipt.
This also applies when concurrent duplicate recovery returns another request's position.
Change reads report applied intent for that original reference, never current readiness.
A missing change is unknown. Missing instance history is refused without terminal proof.
Status excludes workload addresses, Pod ids and credential material; expired waking
intent reads as unavailable. Wake always refuses `profile_or_admission_unavailable`.
The server now exposes these commands through member HTTP routes.
Commands may omit `runGeneration`; a new command uses the current run and an
unchanged retry uses its saved original run. Explicit runs remain checked for internal callers.
`McpInstanceRefused` distinguishes foreign or missing references, conflicting input
and unavailable profile/admission prerequisites. Unexpected dependency errors stay unavailable.
`mcpAdminInstanceStop` checks the owner or admin role before reading another member's
instance. It loads the instance, membership and ownership histories before the two-second
write check. Instance history has a ten-second limit; membership and ownership histories
share a separate ten-second limit. The write check watches
`member-<adminId>` and compares it with the prepared membership position. An Admin's
stop does not watch `ownership-<silo>`, so another person's ownership change cannot
refuse it. A caller using the Owner role also watches `ownership-<silo>` and compares
its prepared position. Both roles still need current permission and applied access events.
The final check refuses an acting admin's demotion or a change to an Owner's authority.
The event records `admin_stop` and the admin's human principal. One conditional append
saves it. An unchanged retry returns the saved run and sequence after later runs.
`mcpAdminInstanceChange` checks the role once, then returns only stops made by that
admin. An owner's start or stop and another admin's stop remain unknown to the reader.
Both admin routes accept opaque ids only; the server supplies silo, actor and run.
`mcpInstanceWorkerRegistration` checks the fixed identity, original start, run,
workload digest, known Pod UID and exact revision before issuing a worker pass.
`mcpInstanceObservation` accepts the checked registration separately from report input.
It rechecks saved facts, rejects changed retries and saves one conditional append.
The append deadline uses the worker pass's remaining lifetime. Replacing the worker
cancels pending backoff and prevents later publish attempts.
It checks the saved result before returning a receipt, including duplicate recovery.
Reports store their checked `expectedSequence`; older observations may omit it.
No membership or conversation streams decide this internal worker permission.
Admin stop commands complete the command part of design row 2. Credential actions stay closed.
No worker runs a saved stop yet.
Every MCP continues to use the shared hosted installation path.

Source checks, 11 October 2026: `03e136e4f8080b154bee7b35fd2e45bafbd2cd88`.
Environment: Linux worktree after `npm ci`; disposable NATS, PostgreSQL and OpenFGA.
This was not a fresh install. Tests-first commit `07a944f6` failed all ten new tests.
PASS: both final focused runs, 277 tests each; `PG_TEST_URL` set, one worker, `nice -n 10`.
PASS: full lint, typecheck, event catalogue (116 types), Knip and changelog checks.
Both authority test files are unchanged. No full root suite ran.
Logs: `/tmp/p3-10-pr2-final-tests-{1,2}.log`, `/tmp/p3-10-pr2-lint.log`,
`/tmp/p3-10-pr2-final-typecheck.log`, `/tmp/p3-10-pr2-events.log`.
NOT RUN: independent review, HTTP journeys, live Kubernetes and fresh-install qualification.

## Final MCP send checks — 11 October 2026

Runtime source: `a6e08fd1`, rebased onto `ef6e3420`. Linux, Node 22.23.3,
disposable NATS/OpenFGA, local PostgreSQL and a recording upstream; no paid calls.
PASS: clean npm ci, requested binary links, lint (warnings, no errors),
workspace typecheck, check:events (115 types), Knip and lint:changelog.
PASS: two final 21-file batches, 889 tests each, in 224.55 s and 180.74 s.
Both used the supplied PG_TEST_URL, nice -n 10 and one worker.
Failing tests were committed before their fixes. The two authority tests are unchanged.
NOT RUN: full root suite, fresh install qualification, independent review and hosted CI.
Logs: `/tmp/p3-6-pr2-tests-rebased-{1,2}.log`, `/tmp/p3-6-pr2-lint-rebased.log`,
`/tmp/p3-6-pr2-typecheck-rebased.log` and `/tmp/p3-6-pr2-red-*.log`.

## Checks for Block during final MCP access reads

Date: 11 October 2026. Runtime source: `18bb3606`, rebased onto `eb67de6e`.
Environment: Linux, Node 22.23.3, local worktree, disposable NATS and OpenFGA,
the supplied PostgreSQL test server and a recording upstream. This is not a fresh install.

FAIL before the fix, as expected: the regression in `61881db0` saved Block through
`setToolPolicy` after the MCP position read, while a member-position read waited.
The upstream received one request. PASS after the fix: the same test records zero
upstream requests and HTTP 403. The test commit precedes the fix.

PASS: the first seven-file batch passed 270 tests in 704.54 seconds. It includes both
changed files, both unchanged authority guards, decision races, gateway and memory-context
checks. The opt-in paid-provider test was skipped. PASS: both changed files passed again,
46 tests in 146.53 seconds. Both runs used the supplied `PG_TEST_URL`, `nice -n 10` and
one worker. The authority files and their limits match main.

PASS: full lint (16 warnings, no errors), workspace typecheck, event catalogue
(121 types), standalone Knip and changelog validation. No dependencies were added.
NOT RUN: full root suite, fresh-install qualification, paid calls and hosted CI.

Logs: `/tmp/p3-6-pr2-review-red.log`, `/tmp/p3-6-pr2-review-green.log`,
`/tmp/p3-6-pr2-review-tests-{1,2}.log`, `/tmp/p3-6-pr2-review-lint.log`,
`/tmp/p3-6-pr2-review-typecheck.log`, `/tmp/p3-6-pr2-review-events.log`,
`/tmp/p3-6-pr2-review-knip.log` and `/tmp/p3-6-pr2-review-changelog.log`.

## Checks for ordered MCP send admission

Date: 11 October 2026. Runtime source: `b056dcfbd845d2041862b8704e3cf58728caea10`.
Rebased onto `d7e253aa`; the rebase finished and main is an ancestor.
Environment: Linux, Node 22, local worktree, disposable NATS and OpenFGA,
the supplied PostgreSQL test server and a recording upstream. This is not a fresh install.

FAIL before the fix, as expected: Block saved during the terminating access pass
still sent one upstream request. The regression commits `3b51b2d5` and `a0623e25`
precede implementation `81afabcd`. PASS after the fix: Block before admission
returns HTTP 403 and sends zero upstream requests. Admission before Block allows
that call and refuses the next one. Two competing calls on the same tool both succeed.
Admission records leave the approval revision and tool choices unchanged on replay.

PASS: the first targeted batch passed 1,067 tests in 26 files in 477.85 seconds.
It includes `mcp-dispatch.test.ts`, `codex-mcp.test.ts`, projection `mcp-evidence.test.ts`,
both unchanged authority guards, `decision-fence.test.ts` and all event-schema tests.
PASS: the three changed files passed again, 57 tests in 212.15 seconds.
Both runs used `nice -n 10 npx vitest run`, one worker and the supplied `PG_TEST_URL`.
Both authority test files still match main exactly.

PASS: full `npm run lint` (16 warnings, no errors), workspace `npm run typecheck`,
`npm run check:events` (123 types), standalone `npm run lint:unused` (Knip) and
`npm run lint:changelog`. All ran under `nice -n 10`.
The first lint run found two extra Markdown blank lines from the rebase; the corrected
full run passed. No production code changed after these checks. No dependency was added.
NOT RUN: full root suite, paid calls, hosted CI and fresh-install qualification.

Logs: `/tmp/p3-6-pr2-order-red-final.log`,
`/tmp/p3-6-pr2-order-boundary-red.log`, `/tmp/p3-6-pr2-rebased-green.log`,
`/tmp/p3-6-pr2-admission-tests-{1,2}.log`, `/tmp/p3-6-pr2-admission-lint-final.log`,
`/tmp/p3-6-pr2-admission-typecheck.log`, `/tmp/p3-6-pr2-admission-events.log`,
`/tmp/p3-6-pr2-admission-knip.log` and `/tmp/p3-6-pr2-admission-changelog.log`.

## Personal bearer commands (P3-8 PR 2, part of #49)

`saveBearerConnection(store, binding, memberId, custody, input, material, db)` is internal
orchestration, with no HTTP route. `memberId` comes from authenticated server context.
Input names `action` (create/rotate), serverId, connectionId, profileId, changeRef,
expectedSequence, expectedGeneration and a fixed appendUntil UTC millisecond deadline.
Material is separate, bounded to 1–8192 UTF-8 bytes, and never returned or logged.
Only reviewed, published remote servers in personal account mode are accepted here.
Hosted and company profiles remain outside this slice.

The orchestration reads history and checks membership before staging with PR 1 custody.
It then starts a fresh membership check and calls the append-only command. This command
makes one conditional append; it never writes custody or a read table. It checks the
saved server revision again and stops append retries at the earliest access, stage or catalogue expiry.
Only member, ownership and member/server control streams participate in the short access check.

The operation id hashes silo, subject and changeRef. History retains retry identity beyond
NATS deduplication. A retry must recover the same private material and exact identity and
match the saved payload. Confirmed appends are read back and compared before returning.
Unknown appends retain custody; these commands never delete it. Explicit candidate cleanup
and bounded live scanning are described below. `foldConnection` keeps old or incomplete
records unavailable and new profiles `saved_unverified`. It reads no secret store and starts
no work.

The existing `profile` event field holds the opaque profileId, never an editable label.
The stream is `connection-<member>-<server>-<profile>`. Selection, identity verification,
release, broker, HTTP routes, UI and fresh-install qualification remain NOT RUN here.
Tests use real NATS/OpenFGA and disposable PostgreSQL, with a custody boundary fixture;
the existing custody tests separately exercise the private HTTP adapter.

## Personal revoke and admin disable (P3-8 PR 3, first part of row 3)

`changePersonalConnection(store, binding, actorId, input)` is internal, with no HTTP route.
The binding and actor come from authenticated server context. Strict input names action
(revoke/disable), userId, serverId, profileId, changeRef and expectedSequence.
Revoke requires the current owner and the profile stream revision. It appends
`connection.revoked` with reason `owner_requested`; replay leaves the profile unavailable.
An admin cannot revoke someone else's personal profile through this command.
Disable requires a current admin, an existing saved profile and the member/server control
stream revision. It appends `connection.disabled` with reason `admin_disabled` on
`connection-control-<user>-<server>`. This blocks every profile for that member/server.
Only a later explicit admin enable could remove it; no enable command exists here.

Each command makes one conditional append. The original change reference recovers its
confirmed receipt after a lost reply, but changed retry details conflict. Membership is
checked again on retries. No token is read or returned, and neither command deletes one.
Save checks the control stream before staging and again in its short access check.
It captures the `connection-*` category position before the final control and profile
revision checks. Its one native conditional append requires that category position to
stay unchanged. The category includes both profile writes and admin blocks, so a disable
that commits first refuses a later save, including create and new-profile reconnect.
A save that commits first remains covered by a later disable. The profile revision check
follows the category read, so competing rotations and owner revoke still refuse stale saves.
A concurrent change to any other connection also refuses this save; the caller can retry.
Other event categories do not cause an append conflict. This uses the existing store
contract without another event or a new event-store API. The shared database lock now
also keeps staging and cleanup apart; the event-store condition still stops late publishes.
Profile history stays outside the short access check. Conversation access checks are unchanged.

Regression tests pause the real append after the final check, finish disable, and then
resume create, rotation or reconnect. Separate tests disable after the final blocker read
and remove the owner or demote the admin during profile reads, on first attempts and retries.
The fixtures use real NATS, OpenFGA and PostgreSQL. Custody stays behind a test adapter.

## Staged connection candidate cleanup (P3-8 PR 3b, Part of #49)

`reconcileConnectionStage(store, db, custody, stage)` checks one supplied private stage.
It returns `retained`, `deleted`, or `absent` for a saved generation no longer in custody.
The live connection cleanup reaction calls it. Replay never calls it, and it performs
no provider call or release.

Saving and cleanup both use `withConnectionStage` with the same silo/member/server/profile
lock name. The existing PostgreSQL advisory lock waits at most 100 ms for acquisition.
It stores no business state. Missing or failed coordination refuses staging and retains
cleanup candidates. Profile history, custody work and lock waiting precede the save's
short access check. The authority implementation and volume tests are unchanged.

Under the lock, cleanup recovers the exact identity from the private journal, verifies
all custody bindings and reads fresh profile history. A current reference is always kept.
An expired append deadline alone proves nothing. At the stage's expected profile position,
cleanup conditionally appends `connection.operation_closed` and reads it back. If a delayed
save arrives first, closure conflicts and material stays. A lost closure reply also retains
material; the next run reads the saved closure and does not append another one.
Deletion requires a later profile position with a valid current generation, saved revocation
or accepted closure. That saved conflict makes a delayed conditional save impossible, even
after a worker loses its lock. A current generation with another reference or a revocation can
therefore retire an old stage. The custody adapter still sends both UID and resourceVersion
preconditions. A conflict, missing record or failed read returns `retained`, without
copying dependency errors or adopting a replacement identity.

This is the first bounded cleanup part under the approximately 600-line review target.
Automatic revoke/rotation reactions are described below. Credential injection remains
planned and must share the cleanup lock. Bounded scanning and journal reconstruction
are described below. The caller must
supply a trusted private stage, never browser input. All credentialed routes stay closed.

P3-8 PR 3c adds the strict `connection.operation_closed` event. Its id hashes silo, subject,
event type and the closed operation id. Its principal is always `system/models`.
The fold keeps the saved generation and reference when a replacement closes. It records the
closed operation id and generation, so a retry refuses before staging and a fresh rotation
skips that generation. The private journal pins Secret names permanently: closing generation
2 means the next rotation stages generation 3. Closing a first create leaves its profile id
unavailable; a fresh connect needs a new id. No adapter or access-check change is needed.

Tests use real NATS and PostgreSQL with a local HTTP Secret fixture. They cover exact
removal, changed UID/version, unknown and current references, lock contention, fresh
reads under the lock, store/read failures and a delayed publish delivered at deletion.
Fresh-install, live Kubernetes and provider qualification are NOT RUN. This does not
complete row 3 or #49.

## Free tool calls and stopped renewals (P3-14 PR 3; Part of #55)

Every MCP send, including memory discovery, recall and remember, obtains
`budget.call_dispatch_admitted` through the existing actor queue. Only reviewed
zero-cost tools qualify for `model: mcp-zero-cost`; no reservation is created.
The one-use pass holds the decision id, body hash and recorded turn's payer,
requester, assistant and generation. The existing conditional tool-rule admission
still follows budget admission. Both must succeed before the sender writes upstream.
A budget stop before budget admission refuses the send. A later budget stop cannot
recall that permission. A user Stop or Block before tool-rule admission still refuses it.

Ask checks budget stops before opening or consuming an approval. Stop after
`approval.used` burns that approval and receives no budget send permission.
The saved computer turn's stream position also checks earlier applicable stops,
even after rollover or a ceiling increase. It comes from server admission, never
from the caller's token. Native descendant calls remain disabled.

Model calls pass that same original position to `reserve` and `admitDispatch`.
The actor checks it inside the reservation queue before holding money. This also
refuses free turns that never attempted a call while their spending limit was stopped.
Renewing a token does not change the original position. A new turn started after
the limit rises can obtain its own hold and send permission.

`mcp-dispatch.test.ts` exercises refused free passes, untouched free turns and renewed
tokens through `/v1/responses`, using the real gateway and a recording upstream.
It also records budget admission before tool-rule admission and saves a user Stop
between them to prove that the call never reaches upstream.

`turnBudgetStop` uses the same budget fold for renewal. Its first history read runs
before the short membership check; later checks read only new budget events.
The personal-payer summary and both authority test limits remain unchanged.

## Safe provider switch-on (P4-22 PR 4e; Part of #104)

`providerSwitchOn` is the only production writer of `provider.managed_calls_enabled`.
It captures the global position, then reads incremental provider, budget and computer
summaries before starting the short authority check. It validates all active bindings
outside that check. One conditional budget append uses `historyChecked` and
`expectedGlobalSequence`. Any intervening event conflicts, including a reservation.
The budget summary also keeps unresolved reservation and dispatch identities.
Computer loss, turn closure and reservation expiry do not clear them.
Only a confirmed settlement or zero-cost release clears a hold or send; an unknown
outcome keeps switch-on refused, including a retry after a lost switch-on reply.
A validated dispatch with no reservation and exactly `model: provider-reachability`
is free, so it does not count as outstanding spending. Its admission record remains
for access, stop and single-use checks. No settlement is invented for old history.
Every reserved dispatch and every other unreserved send still needs saved settlement
evidence. Other unreserved sends have no completion writer yet and remain refused.
These history reads precede the short access check.

`apps/server/test/providers.test.ts` follows real reachability, a consented model test,
model selection, an explicit default, drain and switch-on, then replays projections
and retries with a new event-store reader. Unresolved paid tests and ordinary
unreserved sends refuse until confirmed settlement. The original switch-on fixture
seeded reachability evidence directly, so it never created the dispatch that blocked
fresh installs. A separate test keeps reserved reachability dispatches blocked.
The event schema is unchanged. The saved provider position also identifies the drain
used for a retry: no drain change can save after switch-on.

A legacy start already waiting to append can finish after switch-on. Existing decision
and budget checks refuse its claimless pass before any hold or upstream send. A drain
alone is not proof that every pending admission has finished. Summaries read no keys
and perform no provider requests. Calls use the managed route after the models process
restarts with custody configured and its fallback key setting removed.

The HTTP tests use real NATS, PostgreSQL, OpenFGA and a recording gateway upstream.
They refuse open holds after computer loss and admitted sends after turn closure,
including sends without a reservation. Expired holds and unknown settlements stay refused.
A released hold and a settled paid send each allow the command to complete.

PR 4f adds command-specific settlement, release, duplicate usage, redelivery and
restart/replay proofs in `apps/server/test/provider-switch-on.test.ts`. Controlled
barriers place completion after the captured history position and conflicting
settlement immediately before append. Both refuse with 409. A retry after unchanged
settlement or release returns the original receipt, including after a lost reply.
Late uncertainty that reopens a hold makes the retry return 403 without another marker.
The status GET still returns the historical receipt; refusal does not undo switch-on.
The retry checks the global position too. Reopening a hold between its budget read
and access check returns 409. A later retry reads the reopened hold and returns 403.
An accepted zero-cent release with non-dispatch evidence clears reopened uncertainty
when no final amount conflicts. Settlement saves that release once. Redelivery,
a new actor and event-store reader, and projection replay preserve the zero hold.
Conflicting usage amounts keep the full reservation held and switch-on refused,
even if the release was accepted before those amounts arrived.

Replay uses a new event-store reader and budget actor, restarts the HTTP server, and
rebuilds the PostgreSQL budget projection. Original payer, tariff, charges and mode
are preserved, with no new holds, dispatch admissions, provider requests or custody
reads. Actor startup may record its usual budget-period event. This is an isolated
test fixture, not models-main startup or fresh-install qualification. Paid calls,
dev-stack switch-on and a journey are NOT RUN.

## Catalogue watch and dispatch holds (#48 PR 3b, first split)

`mcpCatalogueWatch` runs beside the active models dispatcher. Startup holds every
configured server and records a failed check before recapture, invalidating old approval
revisions. One check per server runs at a time, for at most 32 distinct servers.
`tick` schedules checks 30 seconds before expiry, at least one second apart. Each attempt
has a 30-second deadline, followed by at most two seconds to save failure. Three
consecutive failures stop automatic retries; attempts wait five seconds between failures.
Replacing the process creates a closed watch and recaptures, including the same digest.
Stopping aborts discovery. Late results cannot append success or release its hold.
Dispatch also checks expiry by time, without depending on a running timer.
Renewal checks the previous expiry again after the event store replies. If evidence
expired during capture or append, the watch saves a failed check and then renews it
before allowing calls. This advances the saved approval revision even when nobody
read an approval during the gap. Uninterrupted renewal keeps that revision unchanged.

The watch closes dispatch before appending drift or failure. A failed drift append leaves
that process held. Successful unchanged checks can recover a freshness pause only after
failure was saved; they retain the newer approval revision. Saved drift and local drift
holds clear only through the restoration rules below. Existing `mcp.tools_changed`
records retain both snapshots.
The models process retains its existing database leader check. No conversation access
stream, authority implementation or authority test is changed.

This watch split does not implement in-process route replacement or instance-start
observation. Acknowledged restoration and saved reload cancellation are described below.
The current routes reload by restarting the models process; its startup invalidates old
approvals. Recapture of an independently restarted backend still needs instance lifecycle
wiring. The gateway delivery helper now provides exact receipts; background delivery
and live generation admission remain separate work under #45.
Fresh-install qualification is NOT RUN. The rest of row 3 remains PARTIAL.

### Watch checks, 13 October 2026

Runtime source: `a3543e19d5e9fccebcbde49843ee1ffb0e5136f4`, based on `c92db7f9`.
Environment: Linux worktree, clean npm ci, disposable NATS/OpenFGA fixtures, the
supplied PostgreSQL test database and recording HTTP upstreams. Not a fresh install.
The tests-first commit is `d94d0b74`; its expected FAIL was the missing watch module.
PASS: initial four-file batch, 94 tests; both final changed-test batches, 45 tests each.
The capture tests also passed twice after replacing the fixture's unchecked JSON cast.
All used `nice -n 10`, one worker and the supplied `PG_TEST_URL`.
PASS: full lint (18 warnings, no errors), workspace typecheck, final models/server
package typechecks, event catalogue (132 types), Knip and changelog validation.
Both authority test files and the authority implementation match the base.
NOT RUN: full root suite, hosted CI, paid calls and fresh-install qualification.
Row 3 remains PARTIAL for the omissions above.
Logs: `/tmp/p3-6-pr3b-tests-{1,2,3}.log`, `/tmp/p3-6-pr3b-lint-final.log`,
`/tmp/p3-6-pr3b-typecheck.log`, `/tmp/p3-6-pr3b-{models,server}-typecheck-final.log`,
`/tmp/p3-6-pr3b-{events,knip,changelog}.log` and `/tmp/p3-6-pr3b-capture-final-{1,2}.log`.

## Recall evidence during an access check

`decisionActivity` accepts prepared and loaded `agent.memory_context_recorded` events
as progress. Invalidated or ended evidence for the checked turn refuses its next
confirmation; another turn's evidence does not. The server records recall evidence
before replying through the existing one-use memory dispatch. No access streams are
added. Complete loaded-reference checks on every dispatch remain separate work.

## Publication preparation (P3-4 PR 2a; Part of #45)

Publication commands save one exact review reference and return the original saved position on retry.
`prepareGatewayConfiguration` is an explicit internal operation, with no worker registration.
It saves reviewed MCP entries, source positions and a digest on `gateway-config-<silo>`.
It rereads after competing conditional appends. The renderer below adds fixed model/memory routes.
Delivery and acknowledgement are deferred to the next parts. Replay calls no preparation.
`gatewayConfigurationCurrent` rejects changed sources or a replaced gateway record.
Each new generation keeps the other servers' entries from the last saved generation.
Only the server being prepared needs its latest intent. This lets two replacement
intents prepare in order even when both were saved before either preparation.

## Saved gateway configuration renderer (P3-4 PR 2b; Part of #45)

`renderGatewayConfiguration(record, settings)` returns `configBytes` (a UTF-8 Buffer)
and `configDigest` (the SHA-256 of those exact bytes). It checks the saved record with
`gatewayConfigurationSchema`, its record digest and every member's fragment digest.
Settings supply listener ports, a plain HTTP loopback decision URL with an explicit port,
issuer, key file path, optional model upstream and egress URL, and the internal memory route.
The function reads no files, environment, clock or random values. The key stays in its file.

The existing `gatewayConfig` and `mcpRoute` builders keep startup output unchanged.
Each saved member supplies one exact POST route. Its CEL rule permits only one
`tools/call` method header and one non-Block name from that entry. Joined header values
prevent repeated headers from matching. Tool names must match `[a-zA-Z0-9_.-]{1,128}`.
Unknown names and entries with no enabled tools have no allowed rule.
The renderer refuses duplicate server ids, paths, route names and tool names, including
collisions with memory. Personal and company account modes are refused.

HTTP ext_authz uses fixed `x-opencrane-gateway-generation`, `x-opencrane-record-digest`,
`x-opencrane-server-id`, `x-opencrane-connection-id` and `x-opencrane-review-revision`
expressions. These replace caller values in the authorisation request. Outbound headers
use the existing fixed list; saved entries cannot provide header names or expressions.
Changing one entry changes the complete record digest in every MCP route. Other routes
remain byte-identical apart from the required global generation and record digest.

`test/gateway-renderer.test.ts` checks deterministic replay, fixed routes, generated rules,
digest and input refusals, and private-data canaries. Pinned-gateway file loading, zero
dispatch counts for refused names/methods, duplicate-header handling and spoof replacement
are NOT RUN here; they remain PR 2c to keep this change near 600 lines. Runtime rule
enforcement is not established by comparing configuration text. No delivery, reload,
witness, acknowledgement, worker or admission change is included. Fresh-install
qualification is NOT RUN.

## Root spending allowance (P4-8 PR 4, first part; #90 and #93)

`BudgetActor.setRootAllowance(binding, firstCallBoundCents)` saves the reviewed bound
only when every remaining cap and the first call fit. It derives rootId as SHA-256
of JSON `[silo, conversationId, turnId]`. Identical retries return the saved record.
`reserve` takes optional rootId as its fifth argument; rooted turns must supply it
and match every saved identity field. The saved root position replaces admittedAt.
`rootTotals` uses the existing reservations, BigInt sums and lifetime settlement.
Roots stay out of `budgetSummary`. Refusals contain fixed reasons and availableCents.
Allowance, ceiling and call-overrun stops are permanent; settlement and replay still work.
An overrun uses the existing `budget_reservation_exceeded` reason and names its
reservationId. The actor saves the first stop before settlement, then records the
full cost and the existing alert. Repeated settlement adds no stop or charge.
A failed settlement or alert can be retried without reopening the root.
Tests in `libs/models/test/root-budget.test.ts` use real NATS and PostgreSQL.
`BudgetActor.stopRoot(rootId, reason, subject, position)` accepts requester_stop,
turn_ended and access_revoked. It reads one event with `readEventAt` under a separate
ten-second deadline before queueing. Inside the queue it checks the saved root,
silo, event type, stream and relevant turn, computer and person ids. It records
sourceSubject, sourcePosition and sourceEventId. Invalid or unavailable evidence
returns the fixed `Root stop evidence refused` error and appends nothing.
The first saved stop is returned on valid retries, including a later different reason.
Only member Stop counts as requester evidence; the budget Stop form is refused.
Chat turn close, completion or failure counts as turn-end evidence. Requester removal
or close on participation, or requester removal on member, counts as access loss.
Access-loss evidence must not precede the root's saved admission position. An old
removal cannot stop a new root after re-invitation; the old root stays stopped.
Parent removal and creator departure remain for activation reconciliation.
`libs/models/test/root-stop-evidence.test.ts` checks exact references, rejected evidence, serial
ordering, lost replies, duplicate-window expiry, old writers and PostgreSQL replay.
No new caller, reaction, route or running-turn interruption is connected here.
Root grant/dispatch and retry checks are described below. The child
dispatcher remain separate work. Stop callers and running-turn interruption are absent.

## Hosted registration — first part of P3-6 PR 4

`registerHosted` derives serverId from silo and commandId. It reuses saveToolCommand
for current admin permission, membership, applied IAM receipts and the two-second
access check. It reads MCP history before that check and conditionally appends
once at expectedSequence 0. Retries compare saved input and the human principal;
the saved event is checked again after store deduplication.
`hostedRegistrationChange` reads only that operation. An absent event is unknown.
Its HTTP caller must check current admin access before calling it.

Dated receipts and the admission GET are implemented below. Recheck commands and
evidence storage remain for part c. Image fetch, scans, deployment and evidence bytes are outside this part.
Fresh-install qualification: NOT RUN.

## Durable budget turn stops (P3-14 PR 4a; Part of #55)

`stop-budget-turns` subscribes to `budget.ceiling_set` and `budget.exhausted`.
It folds through the source event and requires the conversations checkpoint to
reach that position. It reads saved computer admissions with their original payer
and position. Queued human messages use the personal default from before their saved
message position, or the session payer. The provider summary retains default changes
and their positions, so delayed handling and admission choose the same payer. Work
queued before setup uses the first configured default; no configured default still refuses.
`budgetStopId` selects affected work. Each conditional conversation append uses
a deterministic id from silo, stop id, conversation and turn. Conflicts reread;
lost replies retry without a second stop. Existing Stop and terminal reports win.
Waiting approvals use the existing turn-stop invalidation. No computer is required.
Replay updates tables only. Jobs can retry cleanup but cannot reopen stopped work.

Provider status reads only the saved switch-on flag. It does not need call details
from older spending holds.

The provider admission summary now folds spending stops while reading its existing
budget history. First admission checks active stops and stops after the queued message position.
Renewal and model, MCP and memory dispatch use that message position from their existing
conversation summary. Legacy dispatch records with no message retain the computer
admission position. Admission checks again after the computer append, before returning
a pass. A saved stop does not wait for the handler to prevent a send.
History loads precede the short access check. Reader authority streams are unchanged.

Tests use real NATS, PostgreSQL, OpenFGA and a recording model gateway. Bridge
stop-first delivery and reconnect coverage are deferred to PR 4b. Computer grant
removal, status APIs, screens and fresh-install qualification are NOT RUN here.

## Gateway file delivery (P3-4 PR 3a; Part of #45)

`gatewayDelivery` is created once with the child captured by `startGateway.onChildSpawn`.
Its `deliver` operation writes a new 0600 sibling file and renames it over the configuration.
The renderer's digest excludes a control route containing generation, recordDigest,
configDigest and a random reference for this process. A source-address rule admits only
127.0.0.1. The listener still opens on all interfaces; other source addresses receive 403.
`observe` probes with a one-second deadline and compares the exact response. It checks
that the child is alive, this delivery is still active and saved sources remain current.
Only then does it conditionally append `gateway.configuration_observed`. After reading
the saved event, it checks the source positions, latest preparation and live child again
before returning a loaded receipt. A retry probes again and finds the original event
after a lost reply, with the same final checks. An invalidated observation returns null;
its saved event alone does not establish current readiness. Preparation skips observations.
Replay mode writes, probes and appends nothing. Creating a new delivery object requires
another delivery and probe; saved receipts alone cannot acknowledge a restarted child.

The decision stub always allows and supplies the normal request id and dispatch permit.
Recorded outbound names are accept, content-length, content-type, host, mcp-method,
mcp-name, mcp-protocol-version, x-opencrane-mcp-permit and x-request-id.
No caller identity or canary is in the delivered file, recorded traffic or gateway logs.
Malformed input errors are covered by the existing renderer tests.
Remaining: the Ready read, worker wiring, removal of MODEL_MCP_ROUTES
and generation admission. This internal module enables no production call.

Own checks, 14 October 2026, base `808d69c0` plus this branch: PASS — 41 focused
renderer, preparation, reload and delivery tests twice; 419 event security tests once;
136 registry/catalogue types agree. Logs: `/tmp/p3-4-tests-final-{1,2}.log`,
`/tmp/p3-4-tests-1.log`, `/tmp/p3-4-events.log`. Full root suite and fresh-install
journey: NOT RUN. Fixtures use the pinned gateway and disposable NATS, with no paid calls.

## Hosted image admission receipts

`writeHostedAdmission` records one `mcp.image_checked` per installation attempt.
It is private to the models package and absent from the public exports. Server code
and server tests do not import it. Package exports refuse private subpaths; the
existing dependency check refuses relative imports into private model files.
`hosted-admission-boundary.test.ts` checks public and private package imports.
Append validation refuses any principal other than system/models. The fold keeps
its existing source and principal checks. These are application checks, not separate
NATS credentials; per-process NATS identities remain issue #432.
It binds silo, server, attempt, digest and platform. The event id hashes JSON
[silo, subject, event type, attemptId]. Identical retries recover the original result;
changed retries conflict. Only the models source and system principal count.
`foldHostedAdmission` ignores invalid and later results. Checks last at most 24 hours;
scan databases must also be no older than 24 hours when the result is recorded.
All-pass admission expires at the earliest check expiry or database age limit.
Check requests are implemented below. Evidence storage and readers, scans and
deployment remain separate work.
Fresh-install qualification: NOT RUN.

## Reading a saved turn stop

`turnBudgetStopDetails` reads the existing `turn-budget-stops` summary. It selects
at the human message position, like renewal, or uses the saved chat stop id.
It copies only reasons matching the admitted payer and assistant. Unknown saved
stop ids fail closed. `queuedPayer` is shared with the handler for unstarted work.
The summary also retains call positions to order reservations and unreserved
admissions together. `BudgetState` keeps the optional saved settlement `outcome`,
so a confirmed non-dispatch differs from an ordinary zero-cent charge. Call statuses
use the reservation and its dispatch record; expiry never proves non-dispatch after
admission. Only calls with the requested conversation and turn are returned.

## Per-server gateway receipts (P3-4 PR 3b; Part of #45)

After an exact live observation, `observe` saves `mcp.configuration_observed` on each
member's MCP stream. Its fixed id hashes serverId, changeRef and fragmentDigest. Each
append requires that stream's read position and the global position from before the checks.
This also refuses a newer preparation saved during the receipt append. A lost reply is recovered on the next
probe. Unchanged operations carried into another generation receive no extra receipt.
A restarted child requires delivery and a new probe, even when these receipts exist.

`gatewayMemberCurrent` compares the current intent and entry digest, and requires the
same policyRevision as at sourceSequence. Receipts, call admissions and unchanged checks
keep it current. Withdrawal, changed policy, failed checks and replacement intents do not.
The delivery checks the latest preparation again before each receipt and before returning.
The fold retains only a receipt matching its intent and review; no receipt enables calls.
A matching receipt can release a reviewed drift hold. Publication status is read by
`libs/projections` from the catalogue tables. Initial publication and the Ready read
remain unavailable here. Worker wiring, startup route removal, generation admission
and fresh-install qualification remain separate work.

Tests use the pinned gateway, disposable NATS and PostgreSQL. The replay CLI compares
rebuilt policy with the live projection; it writes no events or gateway configuration.

## Ordered gateway delivery (P3-4 PR 3c; Part of #45)

Preparation drops carried members whose source policy or publication is no longer
current. Delivery refuses any record except the latest saved current one before
replacing the file. The worker keeps one delivery object and allows no overlapping
ticks. Lost observation or receipt replies recover fixed ids on a later probe.
Leadership is checked before file replacement, probes and receipt appends.
Delivery requires the root PostgreSQL `Db`, not the connection already holding the
budget lock. It takes `gateway-configuration:<silo>`, the same advisory lock as the
preparation handler. It checks currentness after acquiring that lock and again after
the final leadership query. The synchronous rename immediately follows that last
check, while preparation still waits. Obsolete delivery leaves the old file untouched.
`prepareGatewayConfiguration` remains the event-only helper; a live caller must hold
this shared lock, as the ops handler does. PostgreSQL stores no publication state.
Regression tests use separate PostgreSQL connections to prove both paths wait on
this key. Delayed leadership queries save a newer generation or reject leadership;
refused delivery preserves the file and appends no receipt.
Render settings come from the startup gateway options. Memory is optional; when
present its route bytes are unchanged. Replay performs no delivery or observation.

The delivery tests also check projection-only Ready/Applying/Disabled/Unknown reads,
receipt mismatches, failure deadlines and replay. Generation admission and final-send checks remain row 4. Fresh-install
qualification is NOT RUN. The approval journey prints SKIP until rows 4, 5 and 14.

## Root checks and trusted model retries (P4-8 PR 5 and PR 5b; Part of #90)

`grantModelCall` in `call-retry.ts` handles both legacy and managed model branches.
It finds the root from the verified conversation and turn, passes it to `reserve`,
saves the decision, then calls `admitDispatch` with the exact body digest and root.
MCP and memory grants pass that same root through `checkBudget` and the saved permit.
The actor checks root identity and permanent Stop after `fresh()` in its serial queue.
It uses the root admission position for spending stops. A stopped root releases an
unadmitted hold through `appendNotDispatched`, which refuses any send or usage evidence.
A changed dispatch root conflicts before any write or release. Older internal callers
may omit the root on a held call; the actor copies it from the saved hold before checking.
The new optional event field keeps older admission records readable.

For rooted models, `retryDigest` hashes JSON `[silo, rootId, computerId, generation,
conversationId, turnId, threadId, bodyDigest]` with SHA-256. `bodyDigest` hashes the
exact request body forwarded by the gateway to the decision service. The pinned
gateway may re-encode JSON for the provider. All identity fields come from verified credentials
and the saved turn. Headers and agent-chosen retry ids cannot select a hold.
The actor checks retry state in its serial queue before applying a new spending bound.
Recovery checks current root and spending stops again before returning the old hold.
Only an open, unadmitted hold with no send, effect or security evidence is reusable.
The amount and complete saved call must match, apart from the new random request id.
A changed tariff, payer or context hash conflicts without appending or releasing.
The helper recovers the original allow decision on `decision-<requestId>`, or saves
it there if missing. Concurrent decision appends recover the same saved event.
Admission grants one send and checks the hold's body hash. A lost admission reply
or an admitted call's timeout never authorises a resend; its full hold remains.

Both legacy and managed model branches use this helper. Non-root calls, provider
checks and egress retain their existing paths. Settlement keeps the original payer
and tariff and accepts late usage once. Roots stay out of `budgetSummary`; refusals
use fixed text. No source-evidence reader, stop caller, route, activation or running-turn
interruption is added. `call-retry.test.ts` uses real NATS, PostgreSQL, OpenFGA,
the pinned gateway and a recording upstream, with barriers for concurrent calls.
The managed retry assertion reports only a refusal stage and a fixed reason. Its
observers retain the original access and actor calls and never print request data.
`call-retry-guards.test.ts` checks each retry digest input, saved-decision field,
changed call binding and unsafe hold state before later admission checks can hide
a missing guard. It also checks spending stops on recovery, Stop after a paused
access check, and provider, effect and security evidence before a zero release.
Refusal response tests require fixed text even when the internal error holds private
values. The memory dispatch tests also stop only the root through allowance exhaustion;
conversation Stop cannot hide that check.
Fresh-install qualification and paid calls: NOT RUN.

## Reviewed drift restoration (#48 PR 3c, first part)

Publication preparation accepts a held server only after its exact current catalogue has
been reviewed and its evidence remains fresh. This does not open dispatch. The existing
`gatewayDelivery.observe` checks the current complete generation, live process and digests
before saving `mcp.configuration_observed`; no second acknowledgement path is added.

The shared fold compares the receipt with the current intent, review revision, fragment
digest and source position. Evidence must be valid at both observation and event time.
Only then does it clear `driftHeld` and restore publication. Initial publication activation
still belongs to #45. A failed check clears publication and holds intent-backed servers, so
startup recapture or legacy publication cannot reuse an old receipt. A new review and
publication can restore them again. Failure also advances the approval revision.

The watch keeps freshness and drift holds separately. A successful capture does not
invalidate a review merely because drift is held. It clears its local drift hold only
after rereading the restored policy, matching the captured digest and finding a receipt
whose source follows the saved drift. A failed drift append has no such position and
stays held. Restart always starts closed and records failure before recapture.
After the final policy read, the watch checks the previous expiry and counts of local
holds again. Expiry that has not yet invalidated approvals, or any hold raised during
that read, rejects the refresh. The existing failure path saves a failed check before
returning; the watch stays held until a later successful check. A hold raised again
while recovery was already held also rejects the refresh.

`mcp-dispatch.test.ts` uses product review/publication commands, a real gateway witness,
NATS, PostgreSQL, OpenFGA and a recording upstream. Restoration sends once; pending,
stale, withdrawn and failed attempts send zero requests. The replay CLI compares the
live catalogue with its rebuild without sending or appending events. Pre-drift approvals
stay cancelled. Receipt schema and fold checks also cover foreign and malformed receipts.

The later reload section covers cancellation and unchanged-other-server approval retention.
Scope is PARTIAL: hosted per-start capture, zero-TTL per-call capture and credentialed
discovery are not implemented here. Fresh-install qualification is NOT RUN. The access-check code
and its two named regression files are unchanged.

## Original ceiling lookup (P4-26 PR 1; Part of #108)

`budgetChange` replays the existing budget stream with a ten-second history deadline.
It selects the exact `budget.ceiling_set` command and derives its saved stop from the
shared budget fold. There is no SQL command ledger. Current access controls the
receipt fields; only the active original `setBy` caller can use the minimal receipt.

`BudgetActor.configure` loads previous-command history before `configureBudget`
starts its write check. Membership history has its own ten-second deadline too.
A saved retry compares event type, stream, silo and the complete ceiling payload,
including `setBy`, before returning the original receipt. The expected revision is
not part of the saved payload. Budget reservation churn still conflicts; the existing
managed switch-on revision rule is unchanged. Each new change appends once.
`test/actor.test.ts` covers original receipts after restart, writer replacement and NATS duplicate expiry,
changed callers/payloads and unchanged event positions on retries.

## Loaded memory before dispatch (P4-15 PR 2d; Part of #97)

`prepareLoadedMemory` uses the shared `memory-context-fold` on the turn's saved evidence.
It checks the saved identity and reads each loaded scope before the short access check.
The first confirm checks requester and assistant scope/grant access with the helpers
used by `memoryRights`. Later confirms retain that authority snapshot and its deadline,
checking saved grant changes without repeating IAM reads. Each confirm reads only scope
rows after its checked position, confirms access, then reads scope changes again.
If new rows arrived during access checking, it repeats both checks under the original
two-second deadline. It refuses with `memory_context_unavailable` if they cannot settle
before that deadline. After the final scope read it confirms access again, even when
no scope position changed. This catches revocations saved during that read without
adding scope or conversation streams to the authority fence or extending the deadline.
It then checks every revision and dependency at the current time.

Each stream has its own boundary for a released pass: its last exact position read.
Memory scope positions are read before the final small access check. A correction or
forget visible at that scope read refuses this renewal. If it is saved later, even
while the final access read is still running, this renewal may release a pass. The
next renewal or decision confirmation must refuse with `memory_context_unavailable`.
No extra reads chase later memory changes. The access check still uses only the
small access streams and keeps its original two-second deadline.
Bridge tests save both correction and forget during the final access read, allow
that renewal, then require the next repeated `agent.turn_started` to return the fixed
refusal with no token or context. Both changes visible at the last scope-position
read refuse the current renewal too.

`memoryReferences` has an explicit `event-only` mode for processes without revision keys.
Server reads and writes retain their custody checks. No scope or conversation stream is
added to the authority fence. A turn with no loaded references reads no scope stream.

The confirm also runs inside budget dispatch admission and MCP send admission. Saved
memory additions invalidate older pending passes. Refusals use `memory_context_unavailable`
without memory details. This check writes no context evidence and stops no process.
Cold replay reconstructs references only; it cannot recover a pending dispatch pass.
`test/memory-dispatch.test.ts` in apps/server uses recording model/tool endpoints and a
real memory backend. Barriers cover forgetting during the member read and just after
access returns, at model admission, tool budget admission and the later MCP send check.
They assert no upstream send, no held money and no new send admission. The later MCP
check runs after its separate budget permission already exists. Tests also cover a
backwards scope position, incomplete history, expiry advancing during confirmation,
and repeated unrelated changes reaching the original deadline.
Native memory admission remains disabled.

The server also uses `prepareLoadedMemory` at turn-pass renewal, before signing and
before returning the token. Both confirmations retain one authority snapshot and
reject new loaded evidence during signing. A caller without an IAM binding can check
a turn without references; loaded references always require the binding.

Remaining row 2 work: correction target proofs and agent correct/forget contracts.
Output release and process interruption remain row 3. Initial injection and native
forwarding remain later rows. Fresh-install qualification and real model calls: NOT RUN.

## Hosted publisher verification — P3-6 PR 5, first part

`hosted-verification.ts` is private and has no production caller or event writer.
It accepts an operator trust snapshot separately from the image request. Trust names
one exact repository, a positive version, a PEM public key and a revocation flag.
The signature reader supplies a detached Cosign simple-signing payload and signature.
Cosign verifies that payload with the operator key; the verifier then checks its exact
subject digest, repository and signature type before reading the manifest.
Only a single OCI manifest for linux/amd64 or linux/arm64 is supported. OCI indexes,
foreign layers and other formats fail. Configuration and every layer must match their
size and SHA-256 digest. Candidate bytes are never executed or extracted.

The reader receives repository, resource and AbortSignal. It must limit bytes while
receiving them; this module also checks returned sizes, copies bytes and imposes a
one-second read deadline even if cancellation is ignored. There is no network reader
in this part. Reviewed HTTPS destinations, address pinning, credentials and bounded
streaming remain prerequisites for connecting a real registry.
Limits are deliberately smaller than the design's eventual scan job: 64 KiB signature,
1 MiB manifest/configuration, 32 MiB per layer, 64 layers and 128 MiB total.
The subprocess has a ten-second deadline and 64 KiB output limit. Its temporary files
are private, its environment excludes inherited credentials, and its output is discarded.
`SIGSTORE_REKOR_PUBLIC_KEY` names the local operator key file. In Cosign 2.6.1 this
prevents the automatic TUF metadata download, including with an empty HOME.
`--offline` and `--insecure-ignore-tlog` disable transparency-log lookups; `--key`
still verifies the signature. No public trust service is needed.
Only complete, recognised signature rejection messages from an exit-1 process return
`signature_refused`. File errors and unknown errors return `verifier_unavailable`.
Subprocess output is inspected for that distinction but never returned or logged.

Evidence contains only image/platform, trust version, public-key fingerprint and trust
hash. `currentHostedVerification` must receive current operator trust before evidence
is used; replacement, revocation, changed scope or a changed image invalidates it.
The verifier also repeats that check after reading bytes. Neither result is admission.
No event/API fields changed. Signature and licence passes with pending vulnerability
and malware checks still fail the existing result schema; Continue remains disabled.

Tests fetch checksum-pinned Cosign 2.6.1 into `.tools` using `scripts/fetch-cosign.sh`.
[Cosign's licence](https://github.com/sigstore/cosign/blob/v2.6.1/LICENSE) is Apache-2.0.
This is test tooling only: no binary, dependency or bundled component is added to any
runtime image. The exact runtime binary and its bundled notices still need review
before deployment. Fixtures sign in memory with ephemeral keys; no private key is saved.
The fake registry tests real Cosign verification, both architectures, refusals, byte
limits, outages, trust replacement and pending admission. They make no model calls.
The offline regression uses `strace` to block socket creation and record network calls
across every Cosign thread. It requires a valid signature to pass without any IPv4 or
IPv6 socket attempts. Install `strace` before running this test; CI installs it too.
It is test tooling only, licensed under LGPL-2.1-or-later, with no runtime image change.
File-error regressions replace each scratch file with a directory before real Cosign
reads it. They require exit code 1 to report unavailable, while a wrong key still fails.

The private licence checker below adds Syft and image-specific notice review.
Private evidence storage and worker wiring remain later work. Malware,
vulnerability checks and deployment remain later rows. Fresh-install qualification:
NOT RUN. No computer-image licence exceptions were copied.

## Acknowledged generation admission (P3-4 PR 4a; Part of #45)

`gatewayDelivery.acknowledged()` synchronously returns the generation, recordDigest,
members and gateway stream position last confirmed by `observe()`. It returns null
during replacement, before observation, after child exit or close, and during replay.
The configuration worker exposes the same read. A newer saved request invalidates
admission through one exact `gateway-config-<silo>` position read, without history reads.

For an intent-backed publication, `mcpPolicy` checks all five generated constants,
URL ids, current member, intent and folded receipt using the existing MCP history.
An unchanged carried member retains its original receipt. Legacy publication still
requires its published flag and refuses any generated constant. Approval bindings
keep their reviewed revision; the gateway generation belongs only to the dispatch permit.
The permit rechecks the acknowledgement and exact position at admission and before send.
Backend `route.generation` and `revisionHeader` retain their separate instance contract.

Tests use real NATS, PostgreSQL and the pinned gateway with the recording fixture upstream.
They cover carried generations, stale/spoofed/missing/repeated constants, rejected reloads,
withdrawal, changes during admission, consumed permits and a restarted decision service.
Restoration checks refuse the unsupported conversations `--verify` command, then run
its supported offline rebuild and audit verification without new events or upstream calls.
Conversations verification remains unsupported by the existing CLI. Existing authority tests remain unchanged.

Part b adds `tool.dispatch_started` after `mcp.dispatch_admitted` for intent-backed
publications only. Its fixed id is `<requestId>:tool-dispatch-started` on
`decision-<requestId>`. One conditional append requires the decision to remain the
latest event. An earlier outcome or any failed or uncertain save refuses the call.
The permit is spent in memory before any await and cannot be retried or restored on restart.
Before saving the start, dispatch checks the gateway position, the exact MCP admission
position and then the gateway position again. This catches a newer saved generation
while the MCP read waits, even when it carries the server unchanged. Such a refusal saves
no start. After saving, dispatch rechecks access and repeats these position checks.
A changed position refuses, including another intervening admission. Local
acknowledgement, route and deadline checks follow the last await, immediately before send.
The last exact gateway-position read is the ordering boundary. A newer generation visible
at that read refuses the call. A generation saved after that read is not live yet: the
gateway still runs the acknowledged generation. A call that passed every check may send
once on that acknowledged generation. No extra read or lock extends this boundary.
A refusal after a confirmed start saves `tool.dispatch_recorded` on the same decision
stream with `outcome: not_dispatched` and `evidence: dispatch_refused`, before replying.
The existing outcome writer keeps any already saved outcome and uses one conditional
append. A failed outcome save still refuses the call; it never restores the spent permit.
A lost or throwing start-save reply also refuses the call. The outcome writer closes
that start only if the saved history ends with its exact event id and type. An absent
start or unavailable history cannot be treated as a confirmed save.
`tool.dispatch_recorded` remains the last outcome row for approval retry verification.
The new evidence value does not enable an approval retry; existing retry checks still
require `connection_refused`. Reusing the original permit always refuses.

Tests hold the saved start reply while asserting zero upstream requests, lose that reply,
withdraw publication or revoke access immediately after saving, and repeat a permit both
in sequence and concurrently. They verify the saved gateway fields and later outcome order.
Barriers save a carried generation during the MCP read both before and after the start.
Both send nothing; the earlier refusal also saves no start, and the later one saves a
not-sent outcome. A barrier on the final gateway read verifies that a save visible to
that read refuses with zero upstream requests, while a later save sends exactly once
on the acknowledged generation. Both cases refuse a retry of the same permit.
Other checks cover a real
competing outcome before the decision read or conditional append, expiry during the last
MCP read, and each generated constant on a legacy publication.
Row 5 still supplies the guarded destination; production routes remain empty. Fresh-install journey: SKIP.

## Saved reload approval cancellation (Part of #48)

Every new `mcp.server_published` intent advances that server's `policyRevision` at
its conditional append. The existing approval reader then cancels waiting and unused
approvals, including ones first read after successful restoration. Consumed approvals
keep their saved outcome. Command retries recover the original intent without another
append. The existing gateway preparation assigns the generation; no second route or
integration-specific handling is added.

`publicationRevision` records this invalidation position separately from `reviewRevision`,
which still identifies the exact reviewed tools. Preparation and receipts accept that
review only while no later policy change invalidates it. A replacement of a callable
publication raises the saved drift hold. The watch keeps its local hold until the existing
live acknowledgement restores the exact current publication. A failed or obsolete delivery
cannot undo the invalidation. A new generation carrying another server's unchanged member
writes no intent on that server and preserves its revision and approvals.

Tests use the recording upstream and real gateway delivery. They cover waiting, approved,
unread and consumed approvals, unchanged carried entries for Odoo and memory reloads,
restart, replay, and publication during the final awaited watch read. Tool descriptions
remain inside catalogue evidence; refusal replies and approval records contain no description.
Initial publication activation and in-process route replacement remain separate work under #45. Fresh-install qualification: NOT RUN.

## Bounded connection maintenance (P3-8 PR 3d, Part of #49)

`reconcileConnectionPage(store, db, custody, silo, continuation?)` is a private live-maintenance
entry point. Each call lists at most 25 Secrets in the configured custody namespace,
using the managed-by label. It reads at most 1 MiB and accepts a continuation of at most
4,096 characters. The caller supplies the configured worker silo. Candidates for any
other silo count as examined but not deleted. They stay in custody without acquiring a
profile lock, reading history, recovering a journal, appending an event or deleting a copy.
Only matching candidates pass through `reconcileConnectionStage`.
The result contains counts and a private continuation, never credential material.
Callers retain that continuation between pages and start a new pass after the last page.
Malformed objects or stage annotations stay in storage and are excluded from the
examined count. Healthy neighbours are still checked and the continuation is preserved.
An unknown page result must be retried with the same continuation. An expired Kubernetes
continuation requires a new pass; duplicate checks are harmless. `scanConnections` calls
this entry point during live maintenance. Commands, HTTP routes and replay never call it.

New stages carry their complete stage details in a private Secret annotation. The
existing HMAC check verifies these details before using them to find the profile.
The list response cannot establish the original UID or resourceVersion. Under the
profile lock, the reconciler reads history and checks the original activation through
`foldConnection`. Only a matching saved stage can supply its recorded exact identity
when journal files are missing. Exclusive journal writes preserve existing records;
corrupt or conflicting records are not replaced. Unknown unsaved stages without their
original identity remain stored. A later confirmed activation can provide that evidence.
Older Secrets without the annotation remain stored and need a trusted stage supplied
to the existing individual reconciler. This change does not migrate those Secrets.

Tests use real NATS, PostgreSQL locks and synthetic HTTP custody. They cover restart,
late activation, missing and corrupt records, revoke and rotation, changed UID/version,
store/list/read/lock failure, non-personal candidates, duplicate scans, bounded pages
while earlier pages are deleted, response limits and replay without external work.
Automatic reactions and scanning use this reconciler. Active credential injection
coordination remains outstanding. Credentialed routes remain closed. Live Kubernetes/provider
and fresh-install qualification: NOT RUN. No dependency, event field or API field was added.

## Saved approval dates and cancellation reasons

The [approval API](../../docs/api/approvals.md) defines the optional UTC fields,
first-use retention and dated permit list. Dates come from approval event envelopes,
not read tables or the read clock. The read fold converts saved offset dates to UTC
before returning them to the browser. `approval.cancelled` has its own strict schema
with an optional `cancelReason`; old events still parse without one. Expiry uses
`approval.expired` and has no cancellation reason. Reads preserve unknown outcomes.

`apps/server/test/approvals.test.ts` checks restart, audit rebuild, delayed reads,
offset dates, recorded causes, old cancellations, retry history and identical hidden-id
refusals. `test/approval-cancellation.test.ts` checks unrelated grant changes and
matching requester and assistant revocations.
The reader recognises direct requester/assistant tool-grant revocations only.
Other access refusals do not invent cancellation evidence. A missing turn and
clock-only catalogue expiry still cancel without a reason. UI, native consent,
retry delivery and fresh-install qualification remain outside this change.

## Hosted image check requests

`requestHostedCheck` reuses saveToolCommand for current admin access and one conditional
append. The helper reuses already-read history and supplies an access check to the
event store for each publish attempt. Request data binds the registration position,
expected stream position,
digest, platform and next attempt. Recovery compares the saved event and actor too.
The admission fold accepts ordered human requests only after failed or expired checks.
Unavailable evidence takes precedence over failure. A replaced registration is refused.
The private result writer keeps its models identity checks and accepts only the current
attempt. The first matching result per attempt is retained; replay starts no work.
Evidence storage, leases and evidence GET remain for P3-6 PR 4d.

## Private egress admission (Part of #61)

`startDecision` accepts an optional `EgressRelayRegistry` for `/authorize/egress`.
The handler lives in `egress-admission.ts`. It reads turn facts within ten seconds,
then checks membership, assistant activity, IAM receipts and the three exact
host/port grant streams within two seconds. Team-owned assistants also check their
small team stream. Conversation and computer activity use summaries and later rows,
never whole histories inside the short check. Grant positions must match the pass.
Only command passes for active chat turns are admitted. Desktop passes stay refused.
One conditional `decision.recorded` precedes the serialised zero-cost dispatch check
and relay registration. The saved decision and dispatch prevent pass reuse after
restart. Audit uncertainty refuses connection. Replay registers no listener.

After the dispatch append succeeds, the handler checks current authority once more,
using what remains of the original two seconds. This checks the small member and
assistant streams, any relevant team stream, the three exact destination grant
streams, new turn activity and the turn, grant and optional lease expiry. It never
rereads a whole conversation. A changed authority, expired pass or missed deadline
returns the fixed `egress_refused` response without registering a relay. The existing
`egress.observed` error outcome closes the saved zero-cost dispatch. It has no relay
fields because no listener was registered. A failed outcome save still refuses access.
After registration, periodic checks use the same admission rules. The relay also
keeps its original expiry; it never renews a permit.

Tests use real NATS, PostgreSQL, OpenFGA and the pinned gateway with a recording
upstream. The initial failing test is in commit `98ba6b80`.
Authorised receipt reads, outage watchdogs and live qualification remain deferred. CONNECT and command-worker networking stay off.

## Automatic connection cleanup

`connectionCleanupHandler` subscribes to saved owner revocations and bearer rotations.
It verifies the exact trigger against profile history and sends each superseded saved
activation to `reconcileConnectionStage`. It never calls the provider or releases material.
A confirmed activation occupies its append position, so its superseded material can be
removed before its original deadline. Unconfirmed stages still require the existing
expiry and conflicting-append proof. An absent saved generation makes duplicate delivery harmless.

The handler receives the root PostgreSQL `Db`, not the queue transaction. Cleanup holds
`withConnectionStage` from its fresh history read through recovery and exact deletion.
A future broker must hold this same silo/member/server/profile lock across its current
access and generation checks, custody read and injection. It must deny use if any check,
read or lock fails. Merely checking the lock and releasing it before injection is unsafe.
No broker or injection path exists in this change. Both personal dispatch gates stay closed.

Retained material causes a fixed error and the existing queue retries. Exhaustion leaves
material and the failed job intact. The automatic scan can retry removal independently;
it leaves the failed job intact for operator inspection.
Live Kubernetes, fresh-install and provider qualification: NOT RUN.

## Spending choices at save (P4-26 PR 3, first part; Part of #108)

`configureBudget` calls `budget-scope.ts` for each new command. It loads the chosen
team or shared assistant, its owning team and computer, or the newly chosen default
payer. These exact histories share a ten-second deadline before the two-second
write access check. Unknown or foreign groups and personal, inactive or retired
assistants refuse. No replacement payer or assistant is selected.

The access check watches those exact subjects and compares their loaded positions
before checking current Owner/Admin membership and OpenFGA. It keeps that same
check for the actor's switch-on retry. Saved commands still check current caller
access, but skip scope validation and return their original receipt. Changed scope,
scope id or default payer with the same command id conflicts. Checks add no events.

`test/budget-scope.test.ts` uses real NATS, PostgreSQL and OpenFGA. Barriers cover
deactivation, retirement and demotion after loading and during access checking.
It checks refusal positions, exact retries, no substitution and identical replay.
The existing server budget tests now use real groups and a shared assistant.

PARTIAL: the bounded scope-choices GET, its strict protocol schemas, named choices,
paging and optional-cap read states remain the next part of row 3. No earlier
review defers that work. Personal choices remain unavailable. Fresh-install
qualification: NOT RUN. No dependency or event type was added.

Spending saves also read saved budget history within the separate ten-second limit.
Only a current saved default of exactly `installation-default` can be reused without
a team stream, both when selecting the global default and when setting its
`paying_group` ceiling. Startup and `migrateBudgetDefault` already record that payer.
Both paths read budget history before the two-second write access check. The expected
budget position still prevents a save if that history changes before the append.
Every other default, including an unknown id already saved in older history, needs
a real team in this silo. It creates no team and never changes the payer without
the admin choosing it.

Choice refusals return HTTP 422 with exactly
`{"status":"refused","reason":"spending_choice_unavailable"}`.
Caller membership and OpenFGA permissions are checked before this reply. Lost
Owner/Admin access still returns 403. The reply mapping lives in `budget-scope.ts`;
`decision.ts` only forwards its status and fixed body.

## Hosted image licence checks — P3-6 PR 5b, Part of #47

`hosted-licences.ts` remains private, with no production caller, event writer or deployment.
It retains copies of registry bytes, passes those copies through `verifyHostedImage`, and
stages them as an OCI directory only after verification passes. It never fetches them again.
Syft 1.54.0 scans that local directory with `all-layers`; no candidate process runs.
The scanner binary and SPDX 3.28 data use the existing computer build's checksum pins.
The test downloader adds neither to a runtime image. Syft's [Apache-2.0 licence](https://github.com/anchore/syft/blob/v1.54.0/LICENSE)
allows this tooling use; runtime packaging and its bundled dependency review remain unqualified.

The operator supplies a separate JSON review file, never an installer or image declaration.
Its `imageDigest` binds the exact manifest. `inventory` maps each compressed layer digest to
all regular file paths and hashes, including files later deleted. `packages` names every
expected `type:name@version`; scanner omissions or extra packages fail. Reviewers must include
unrecognised binaries in `evidence.artifacts`. `noticeHashes` pins all collected metadata and
notice files. `applications`, `texts`, `aliases`, `debianLabels` and `evidence.apt` use the
existing computer licence policy's formats, with no computer review entries imported.
The operator must verify apt evidence against signed Debian archive indexes; image-supplied
apt claims do not establish trust. `osLayers` explicitly lists the reviewed OS layer digests.
Every Debian package location must belong to those layers, with exact archive identity and
main-component evidence. Application packages still require OSI licences in those layers.
Bundled free notices require their own component, source, licence and reason.

The Python checker imports `apps/computer/check-licences.py` for the shared policy and reads
archive members without extracting them. It checks expanded layer hashes before scanning.
Current limits: the verifier's 128 MiB fetched bytes, 512 MiB expanded bytes across all layers,
50,000 entries and 16 MiB per regular file. Links, special files, zstd layers, duplicate paths
within a layer and differing notices at the same path across layers refuse this initial gate.
Later bounded extraction work can extend that supported set. Each subprocess has a 60-second
deadline and 16 MiB output limit. Temporary data is private and removed after the attempt.
No inherited credentials enter the scanner environment. Results contain only fixed codes,
image/trust evidence, SBOM and review digests. Trust is checked again after scanning.
Raw SBOM retention in authorised evidence storage remains later work.

Tests use generated signed OCI bytes, a fake registry, real Cosign and real pinned Syft.
They cover complete application/OS reviews, missing or changed notices, unknown and forbidden
licences, incomplete inventories, OS misclassification and scanner/registry outages.
Existing verifier tests retain both architectures, wrong signer, substitution and hash checks;
the admission schema still refuses signature/licence passes with the other checks pending.
Fresh-install qualification, production scanning, malware/vulnerability checks and startup:
NOT RUN. No browser, authority, event or API contract is changed.

## Published remote HTTPS calls (Part of #45)

`remote-https.ts` owns DNS checks and the pinned HTTPS exchange shared with discovery.
Explicit operator and memory routes retain their existing contract. With no operator
route, a published remote server in account mode `none` uses only its saved locator.
Its reviewed `discoverResult` must declare
`capabilities.experimental["io.opencrane/expectedRevision"]`; otherwise it refuses
before DNS. This declaration promises atomic refusal of a mismatched
`x-opencrane-mcp-revision` before running a tool. Unsupported servers stay unavailable.
Remote calls require both dated saved evidence and the running catalogue watch at
admission and immediately before sending. A hold raised after a permit or saved start
refuses the send without opening an upstream connection. Authenticated adapter outcomes
and unknown-result handling remain unchanged. The watch reconciles a bounded list of
server ids; removal aborts active capture and retains any unresolved local drift hold.
Each capture compares the latest remote revision declaration with the saved one before
renewing dates. A withdrawn or changed declaration saves the latest discovery as a changed
catalogue, even with identical tool hashes. The hold starts before saving that event.
`mcpCatalogueWatch` accepts an optional `timeoutMs`. It defaults to 30000 ms,
as before, and bounds both the abort timer and event-store read deadline. It must
be a positive integer no larger than 2147483647. Production callers omit it; the
stalled-capture dispatch tests pass 500 ms. Failed-check saving keeps its separate
two-second deadline. Approval invalidation, retry delays and expiry rules are unchanged.

Short positive TTLs are checked after one quarter of their lifetime. Longer TTLs keep the
30-second refresh margin and the inventory's 300000 ms cap. Zero TTL remains refused.

DNS takes at most one second and no longer than the remaining permit/access lifetime,
before admission or start saving. Every answer must be public. TLS uses the checked
address, saved hostname, certificate verification and no shared agent. The existing
last gateway-position read still determines send ordering. Bytes are unchanged.
Only Host, Content-Type, Accept, Content-Length, MCP version/method/name and the reviewed
schema digest leave the process. Replies must be HTTP 200 JSON, at most 1 MiB and without
an MCP session; only Content-Type is forwarded. Errors return fixed 502/504 responses.
The whole HTTPS exchange has a 30-second deadline and never retries or follows redirects.
Remote starts carry `adapter: remote_https`. Only the consumed permit's private callback
can save `adapter_response_received`, `adapter_transport_uncertain` or
`adapter_dispatch_refused`. The last requires a confirmed start and a refusal before
opening a connection. It allows the requester to record `approval.retry_requested`
once; the next successful call cannot reuse that proof. No money is held for these
zero-cost calls. The recorder checks
the silo, decision id, start id, connection, generation, record digest and review revision
against saved history. It uses the existing outcome id and conditional append, then reads
back a lost save reply. It never repeats the remote call. No public observation route exists.
Generic gateway evidence cannot settle a marked remote start, even when it arrives first.
Operator and memory observations keep their existing behaviour.

A complete UTF-8 JSON-RPC response with the matching id and a result or error object proves
`responded`, not tool success. Duplicate keys and malformed replies remain unknown, as do
resets, redirects, timeouts and TLS failures. The callback must confirm its evidence before
returning a checked reply; an unconfirmed save returns an empty 503. Request/reply bytes,
credentials and addresses never enter this evidence. Missing observations after a crash
remain unknown; replay never sends. A lost start reply also stays unknown. Crash
reconciliation remains separate work. Fresh-install qualification: NOT RUN.

`mcp-dispatch.test.ts` uses the recording TLS server, real gateway, NATS and PostgreSQL.
It checks exact bindings, lost saves, store outages, changed history, forged external
observations, earlier/later gateway evidence and restart without another send.
Direct recorder tests seed a saved start without sending a request. They check that
identical callbacks add nothing, foreign silos are refused, a later response cannot
confirm a saved unknown outcome, and conflicting saved evidence is refused after a
lost save reply. Each checks unchanged history and no upstream request. Removing
each corresponding guard makes its test fail.

## Native request cost and dispatch (P4-11 PR 2g; Part of #93)

`reserveNativeCall` takes the raw body instead of caller cents. It uses the strict
request schema shared with `decision.ts`, requires the turn model within the saved
scopes, and computes `requestReservationCents` before asking the actor for a hold.
Invalid JSON, extra fields, another model, n other than 1 and output bounds outside
16–2,000 refuse before any budget event. The schema's behaviour is unchanged.

The actor's internal reservation recovery and dispatch methods accept the checked
root turn separately from the child's turn. Native checks require `fresh()` before
checking capacity. Dispatch checks Stop and exhaustion on that root, saves one
admission, and keeps an admitted hold after a lost reply. Refused unsent holds use
`appendNotDispatched` to settle at zero. No new event or wire field is added.

Tests use disposable NATS, PostgreSQL and OpenFGA. They cover computed cost, strict
body refusal, one dispatch including lost replies, Stop, the 240/110/400/300 example,
queued revocation without stopping the root, mandatory fresh access, allowance
preload before the short access check and another writer's Stop during confirmation.
The route test withholds a valid body until the disabled response arrives.

PARTIAL: part 2h must connect native calls to `grantModelCall` using the saved root
and root turn. That includes exact body/retry identity, request-id and decision
recovery, competing replicas and changed-binding refusal. This internal hold helper
still allocates a new hold per invocation; no production route calls it.
Native token minting, both `multi_agent=false` settings and the refusal before body
reading remain unchanged. Row 3 owns enablement. Fresh-install qualification: NOT RUN.

Regression checks also remove six guards one at a time: queued access refresh,
allowance preload and renewal, root-turn forwarding at dispatch and retry, and
single admission after a lost reply. Each removal fails its targeted test at the
expected assertion. The guards are restored for the passing runs.

## Relay startup and revocation checks (Part of #61)

`startEgress` creates `MODEL_STATE_DIR/egress` with mode 0700 and refuses an existing
non-directory or wider permissions with `egress_directory_refused`. Each retained
close record is checked against its silo-derived filename and existing receipt checks,
then retried once. Invalid files stay in place and produce only `egress_receipt_refused`.
Registration prepares one receipt before listening. Closing captures the record through
that receipt. Shutdown closes all relays as unavailable and waits up to two seconds
for receipt saves. Restart scans evidence only; it never registers a relay.

Each relay checks every 500 ms, with no overlapping check. It retains its admitted
claims and the histories and positions of the exact member, assistant, team and three
destination streams. Later checks read their heads and new events only. They reuse
admission checks under a fresh two-second authority fence. Turn and generation changes
use the original `approvalActivity.confirm` tails; conversation history is never reloaded.
Saved spending stops use `requireBudget` on the actor state, without a reservation.
Harmless settings changes and unrelated assistants' stops leave the relay open.
Team membership receipts are required only for the requester. Another member's pending
addition or removal leaves the relay open. Team-wide events still require their receipts.

Scope cutoff: items 1–2 only. The next part must add an independent outage watchdog,
classify unavailable dependencies separately from revocation, check actor availability,
and retry pending receipts after recovery without restarting. A stalled check currently
waits for its dependency; its deadline alone cannot guarantee two-second outage closure.
Crash markers and the authorised receipt read follow in 2g. No live egress capability is
claimed: `models-main.ts` still supplies no `egressDecisionUrl`, so CONNECT stays off.

Own checks use real NATS, PostgreSQL, OpenFGA and the pinned gateway. Tests cover each
of the three destination revocations, member removal, assistant inactivity, ended turns,
conversation closure, changed generation, spending stops, harmless updates, narrow reads,
private directories, retained-file refusal, restart deduplication and permit reuse.
Fresh-install qualification and the deferred outage watchdog: NOT RUN.

## Scheduled connection scans (P3-8 PR 3f; Part of #49)

`scanConnections` receives the configured worker silo and passes it to every page check.
It runs one pass at startup, then on a fixed 15-minute timer. Tests pass
shorter intervals. Pages run sequentially to the end; ticks during work are skipped.
An unknown page waits for the next tick with the same private continuation. A second
consecutive unknown page discards that continuation and the next tick starts from the first page.
A successful page clears the consecutive-unknown state.
Abort stops further list requests and waits for the current bounded page to finish.
Logs contain fixed text and examined/deleted counts only; the loop returns no page data.
The worker shares custody with the cleanup reaction and starts scanning only after
subscription checks. Replay never starts the loop. No new setting or event is needed.
Tests use real NATS/PostgreSQL and HTTP custody, including exhausted retries, restart,
late activation, pagination, slow/unknown pages and dispatch during a hanging list.
The mixed-page test uses two real NATS stores and retains the other silo's current copy
without adding anything to the worker's store. Timer tests check the default at 899,999
and 900,000 milliseconds and retry an unknown page after an intervening success.
Row 3 is complete apart from live qualification. Live Kubernetes, provider and
fresh-install qualification: NOT RUN. Next for #49 is row 4, company opt-in and selection.

## Declared tool evidence for mode changes

`setToolPolicy` requires both explicit zero cost and saved approval details for Allow
and Ask. It cannot fill missing declarations. Exact review uses the same requirement
in `reviewedToolChoices`; the projection checks it again when applying mode events.
History still loads before the two-second authority check. No access streams changed.

## Tool permissions immediately before sending

Ordinary MCP permits call `currentAuthority` again during dispatch, including after
`tool.dispatch_started` is saved. This queries current IAM permissions and their
applied event receipts. It reuses the conversation history loaded before admission
and the original two-second deadline; it reads only the small access streams.
The existing activity check still catches later turn stops and access changes.

`apps/server/test/integration-access-gateway.test.ts` proves the published HTTPS
path. Pausing OpenFGA after a saved start previously returned 200 and sent the call.
The regression requires refusal with no new upstream connection or bytes, alongside
a successful control, separate admission evidence and fresh-call refusal. The same
matrix covers product grant and group commands while IAM application is paused.
Fresh-install qualification is NOT RUN.

## Shared test ports

The nine former `freePort` copies now use `@opencrane/event-store/testing`.
Each Vitest worker uses 200 ports, starting at `20000 + VITEST_POOL_ID * 200`.
Workers 0 to 24 are supported. The helper skips `EADDRINUSE` and stops after
200 attempts. This keeps ports below 25000, away from the secondary dev stacks
at 25100 and 25200 and the Linux outgoing range starting at 32768.
Separate test runs can share worker ids, so listeners are checked before use.

`startGateway` keeps the last ten stderr lines after removing private details.
Only recognised startup and bind failures reach errors; other lines are withheld.
The port-conflict tests occupy a real readiness port and check the reported cause.
The admission benchmarks pause the first grant read until the cold request is refused.
That request must return 403, record Deny and hold no money. Background event delivery
stops before loading grant history. Catch-up is joined directly, with a separate
two-minute limit, as before; no admission retry loop is used. One successful warm-up precedes
the measurement. Both calls must return 200. The measured call adds exactly one
reservation, reads no old grants and finishes within two seconds. Neither successful
hold is settled. The separate saved-Allow timeout test retains its 503 refusal and
requires the unsent hold to settle at zero without releasing an earlier hold.
