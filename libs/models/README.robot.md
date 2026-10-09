# Models and silo spending

For people, read [README.md](README.md) first.

## Budget writes

BudgetActor replays every budget event before writing. Its appends opt into the
event store's `historyChecked` mode, using the last applied sequence. Ordinary
commands use fresh UUIDs. Configure checks its caller's command id against the
history before appending. A lost reply is found after the original position;
another writer's event causes a conflict and disables the old actor.
`test/actor.test.ts` checks reservation reads on 500 events, configure repeats
and the old actor stopping without holding money.

## Recovery after store outages

Expiry releases a hold at zero cents with `outcome: not_dispatched` when
its request has no matching allow decision, no provider dispatch record and no
record in `effect-<id>` or `security-<id>`. It reads these records before releasing
money. Failed reads leave the hold for a later check. A matching allow decision
or any evidence of a call keeps the hold and records `effect.uncertain` with
`reason: settle_timeout`. A dispatch without an allow decision also raises a high
`effect_without_permit` alert. Older holds without a request id keep the same
uncertainty rules. A hold that may have been sent is never refunded by time.

A retry of a provider check never sends it again. It returns the original receipt
without writing while the first check may still be running. Recovery can finish
an attempt only after its reservation is older than the 15-second gateway timeout
plus a five-second margin. Without a reservation, the original request must be
older than that same limit. When no dispatch exists, recovery records
`provider.verification_recorded` with `outcome: unknown` and the original
reservation id, if one exists. It includes settled cents only when the local
budget actor has already settled the hold; otherwise the budget stream shows
whether the money is still held or has been released. An allow decision still
keeps the hold uncertain at expiry, even when a final result exists without a
dispatch. That case needs manual resolution.

The result and dispatch use conditional appends on the same provider stream.
Gateway admission refuses a finished attempt. Ordinary model admission checks
that its hold is still open after saving the allow decision. It checks current
access again inside the budget queue, using the original two-second time limit.
If that access check fails, it releases the hold at zero before returning the error.
No permit has left the process at that point. It refuses the call
if expiry already released the hold. A disabled budget writer must be
replaced before expiry can release a hold that was never allowed or sent.

When an allowed call reports an unknown result after a zero-cent release,
`uncertain()` saves `budget.settled` with `settledCents: 0` and `outcome: unknown`.
This makes the full reserved amount count against spending limits again without
claiming a known charge. Duplicate reports do not write another settlement, and
replay restores the same hold. Without an allow decision, the report raises
`effect_without_permit` and does not restore the hold.

Provider admission and expiry still run separately. A dispatch can be saved after
expiry reads the provider stream but before it releases money. Reaching this gap
requires a clock jump of 180 seconds or more between reservation and admission.
Later usage or uncertainty restores the hold, but a crash before either report
can leave the zero-cent release in place. Two leaders serving together with that
much clock skew can also allow a call before the newer leader releases its hold.

`test/actor.test.ts` covers expiry, late uncertainty, repeated checks and budget replay.
`test/hold-leadership.test.ts` covers a stale leader allowing a call during expiry
and the same-actor refusal that prevents that ordering.
`test/hold-recovery.test.ts` covers two consecutive store failures through
provider checks and ordinary calls. Ordinary calls have no provider-result
write: the corresponding case loses the reply after saving the zero-cent
settlement. `apps/server/test/providers.test.ts` covers a same-id retry during
a live check and expiry racing admission through the real gateway.
The tests use disposable services and
never send a paid model request.

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

`startGateway({ ..., mcpRoutes: [{ serverId, connectionId, upstream }] })` adds a
fixed, operator-reviewed fixture route `/mcp/:serverId/:connectionId`. This is
not an installer or arbitrary remote-URL interface. ext_authz accepts only bounded
MCP `tools/call` for 2026-07-28 with matching method/tool/version headers and
required `params._meta` version, thread id, call id and bounded client capabilities.
The tool-name header is `mcp-name`. The route strips caller
headers and never injects an invented credential. Only explicitly credential-free,
non-metered reviewed fixtures priced at zero can run until the credential/budget tickets land.
Ask records `approval_required` without dispatch; approval creation/consumption
belongs to P3-2. Lossless approval argument binding belongs there too.

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
policy sequence, connection/profile and argument/review digests. Only the original
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
live turns, requester/assistant `memory_read` and `mcp_server` grants, and Allow recall policy.
Claims bind silo, requester, assistant, computer/generation, conversation, turn, thread,
operation, person scope, private content class, call/decision ids, body digest and event position.
The server verifies ES256, issuer, audience, expiry within two seconds and body/thread binding,
then rechecks live rights and policy. Only an explicitly recorded `restricted` turn is allowed.
Legacy starts without a mode, `memory_free` starts and shared-only contexts are refused.
Both `memory_read` and `mcp_server` need current recorded `grant.given` events for
the requester as `member` and the assistant as `assistant`, as well as OpenFGA permission.
A revocation without a kind removes both matching identity kinds. Leftover OpenFGA
permissions and grants for another identity kind cannot replace these recorded grants.

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

Remaining work: select the assistant or silo default binding at turn admission,
send the selected model to the computer, migrate with separate resumable commands,
and record a switch-on event that cannot strand running turns. Managed dispatch
also needs the real gateway proof and provider/key checks from row 5. There is no
switch-on command or retirement in this first change.

`test/provider-turn-contract.test.ts` uses real NATS, PostgreSQL, OpenFGA and the
pinned gateway with a recording upstream. It checks zero holds and sends for bound
or incomplete tokens, unchanged legacy traffic, matched issuance and reservation
replay with the original cents and tariff. Set `PG_TEST_URL` to a disposable server.
Fresh-install migration, paid calls and retirement remain NOT RUN.
