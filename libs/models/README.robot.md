# Models and silo spending

For people, read [README.md](README.md) first.

## Dated MCP catalogue evidence

Tool lists carry check and expiry dates; undated lists cannot authorise calls.
`tool.approval_requested.policySequence` stores the stable `policyRevision`,
not the latest MCP stream position. Unchanged checks keep waiting approvals valid.
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

## Internal descendant admission

`admitDescendant` saves one `computer.turn_started` for a signed internal decision.
No route or production signer calls it. The separate `delegation.started` stage,
root allowance checks and native call decisions remain for the next part of #93 PR 2.
The native bridge, thread grants and Stop work remain in later design rows.

The decision uses ES256, the configured issuer, audience `delegation-admission`,
`typ: descendant-admission`, the silo, and the full native start binding. It expires
within 120 seconds. Its `jti` and delegation id are the SHA-256 of the JSON array
`[silo, rootId, computerId, generation, spawnItemId, threadId]`.
No signature, another audience or a changed signed payload refuses admission.

This first part accepts only private agent sessions with an explicit `memory_free`
root and a saved model/provider choice. Older roots and shared sessions refuse.
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

History and grant summaries load before the two-second access check. That check watches
only the existing small authority streams. Later root activity is read incrementally.
`test/descendant-admission.test.ts` uses real NATS, PostgreSQL, OpenFGA and gateway
fixtures. `test/delegation.test.ts` retains the refusal of native credentials and calls.
These computer admissions grant no call authority and create no budget event or hold.

## Budget writes

Native descendant model admission is explicitly disabled in `requireTurnDelegation`.
No root allowance or child reservation path is introduced by the delegation contracts.
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
Tool and memory callers follow in PR 3.

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
No extra proxy sees the provider key. `backendAuth.key.file` reads
`.keys/.openai-key` inside agentgateway, never the server or computer.

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
  only a matching Ready event permits model admission. Delegation
  currently contains only the requester; multi-hop delegation is deferred.
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
Owner/Admin and current membership inside a two-second authority fence before
queuing the append. Never send a bare asserted member id to the decision process.
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
The built-in memory route retains its separate signed-context checks at its backend.
The shared policy reader returns the registration kind without refusing hosted memory.
The ordinary sender checks that kind before binding or issuing a pass and refuses hosted
images until image admission exists. Memory previews, discovery, recall and writes keep
their existing policy, grant and backend checks. They create no shared send admission.
Memory routes retain the original header replacement. Their signed memory context
replaces caller credentials. Ordinary routes add the send pass. Reading a missing pass during
memory header replacement makes the gateway retain caller credentials, so it is excluded.
Approvals include `dispatchBinding`, the route hash, in their id. A replaced backend or
generation cannot use an old approval, including a late approval decision.
Hosted image admission, recorded lifecycle generations, configuration acknowledgement and
automatic card cancellation on lifecycle changes remain later design rows. These fixed routes
provide no image admission or installer. The P3-14 shared send gate is not merged; this small
permit check adds no spending gate and can move behind it later.

### Open items

The memory MCP route already bypasses this sender on main. Its signed context can be
reused within its lifetime and has no backend generation or catalogue revision. A
follow-up PR moves memory MCP onto the shared dispatch check and retains its scope,
access and write checks. This PR leaves that route's runtime behaviour unchanged.

Model and MCP admission share `currentAuthority`: current member/role, team
membership, assistant activation, conversation participation, requester and
assistant grants, and OpenFGA permission checks. Every required event must have
reached OpenFGA before admission. Decision receipts cover the requester, assistant
and team grants, including revoked team grants. Another member's direct grant
needs no receipt for this call.

Decisions share one two-second budget for computer credentials, new
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

`approvalCards`, `readApproval` and `decideApproval` replay approval streams; reads
record expiry/cancellation through conditional appends. A request is bound to silo,
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

Only `/mcp/memory/server` receives signed `x-memory-context` after ext_authz checks
live turns, requester/assistant `mcp_server` grants, and Allow recall policy.
Recall also requires current `memory_read` grants for its selected scope.
Claims bind silo, requester, assistant, computer/generation, conversation, turn, thread,
operation, selected scope, private content class, call/decision ids, body digest and event position.
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

`memoryReferences(rows, silo, scopeId, custody)` checks metadata and key status without
reading fact text. It keeps the first metadata for an equal revision, as the projection does.
It walks all historical dependencies, refuses cycles and keeps legacy corrections or
tombstones unusable. Missing or damaged custody raises an error. Private turn previews omit
references that cannot be checked. Discovery offers recall only until trusted records cover
every loaded memory reference.

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

Remaining work: safe switch-on must prove that all legacy admissions and turns
have finished before saving the marker, including admission already waiting to
append when draining began. It must also check reservations and migration choices.
The switch-on command, managed gateway startup, fallback-key refusal and recorded
switch-off are not built here. Retirement remains unavailable. Fresh-install
migration and managed dispatch are NOT RUN; this is source preparation only.

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
`unknown`. After restart, a pending deletion only checks absence. It never repeats DELETE
or adopts the version changed by a finaliser. A failed request also leaves deletion
unresolved; a later absence check can finish it. Conflicts and unknown outcomes retain
material. A 404 never proves failed activation. The later orphan reconciler must prevent
late appends before cleanup. No routes, event writes or material releases are registered.

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
The shared final gate covers model sends and provider verification checks.
Tools, cancellation, queued messages and participant notices follow later.

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
integration with the final dispatch gate remains unfinished.
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
Observation commands, admin commands, worker registration and credential actions remain
the next part of design row 2. No worker runs a saved stop yet.
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
