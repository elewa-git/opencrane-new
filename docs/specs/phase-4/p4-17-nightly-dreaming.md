# Nightly dreaming within one memory scope and budget

Design for [#99](https://github.com/elewa-git/opencrane-new/issues/99), parent #82, 10 October 2026.
Design only. Repository inspection was read-only on `work/p4-17-design`.
HEAD, local origin/main and GitHub main read as `dd3880237b87f98bab1793a5e1ceec1addfdfbbc`.
Only this external note was written. Tests, stacks, model calls and live evidence: NOT RUN.

## Basis and delivery gates

Read #99 and its Design section; #93–#99, #104, #106/#107 and #110; defaults on #93/#94/#95/#97;
accepted `/home/jente/.fleet/reviews/p4-{11,12,13,15}-design.md`, especially p4-15 section 4;
AGENTS.md, plan.md Memory, engineering standards, Phase 4 tickets/spec/D15–D20,
`p4-12-memory.md`, event catalogue, handoff PLAN and ADRs 0002/0004. Inspected the requested
handler, ops, budget/gateway/authority, server memory/chat, computer, projection, web and dev
relay paths. Read the 06-mem README/HTML and all eight requested desktop/390px PNGs.
Network reads were GitHub-only, including pinned pg-boss source; no model endpoint was called.
Main has encrypted revision keys, human store/read/status, governed recall and person remember,
and the read/store panel (#94: #284/#289/#292/#293/#299/#304/#306/#313, among its earlier slices).
It does not yet provide the complete correct/forget, loaded-reference, shared-only or nightly path.
Issues #323 and #327 remain open prerequisites. GitHub now reports #328 merged, despite the task's
opening status; that PR supplies delegation contracts/replay, explicitly no root allowance.
The inspected main SHA still lacks it. Reconcile landed source before implementation.
Issue #300 preserves provider/model choices and spending holds; managed provider dispatch remains gated.
`chat/memory-admission.ts` is disabled. #96/#200 qualification must pass before paid dreaming.
Reuse PostgreSQL, NATS, pg-boss 12.35.0 (MIT), Node crypto, Zod, jose and the existing gateway.
No new dependency, embeddings, scheduler service, general workflow engine or server model loop.
Build and qualify on a fresh dev stack first; Helm belongs later. Use tailnet access only,
never Tailscale Funnel. This feature requires no Zitadel change; any later one stays in
“OpenCrane 2 Dev”. Facts, source labels and model replies remain untrusted data.

## 1. Dirty scopes, nightly identity and admission

A scope is the existing hash of silo, kind and owner id. Exactly one `person`, `group` or
`assistant_notes` scope belongs to a run. A group id is not a human execution identity.
Add a checked `bindMaintenance` command and `memory.maintenance_bound` event on its scope stream.
Record an active consenting member as owner, assistantId, payer, enabled and accepted cap: 100 cents.
Person binding requires that member to own the scope. Group binding requires current membership
and an assistant owned by that group. Notes binding requires the assistant's real audience,
actsFor and read/write grants. Require payer membership/authority and explicit acceptance of the
nightly cap. Humans bind through the ordinary authenticated API; no first-read auto-enablement.
Rebinding, disabling or revoking stops current work through #93; new bindings start next night.
Never choose the first administrator, online participant or replacement owner automatically.

Project dirty candidates from accepted fact events: written, human correction (including pin),
forget and the resulting dependent invalidation. Forget requires metadata cleanup, never a recall
of forgotten text. A recorded expiresAt becoming due also makes maintenance due; calculate this
from the stored timestamp and clock in TypeScript, without needing a new “time passed” event.
Cleanup evidence and run-status events do not themselves make facts dirty. A maintenance correction
marks its own accepted result reviewed, so it cannot cause an endless nightly rewrite cycle.
Keep per-fact reviewed revisions: no-change reviews only its exact inputs; omitted/new facts stay dirty.
A dirty scope with no eligible content records no_changes without model/tool dispatch; cleanup is #95.

Recommended initial bound: one batch, one model attempt and at most one correction per scope/night.
Take a stable prefix by oldest unreviewed position then bytewise fact id, at most 32 input references
and 16 KiB for the complete escaped input block. Stop at the first whole fact that cannot fit;
retain 4 KiB facts and no backfill. Include pins as protected data; never add another scope's pins
or preferences. Due expired facts contribute metadata only, not unusable text. Backlog stays dirty
for later nights. Publish these limits; expanding throughput is a later measured change.

Derive inputRevision from SHA-256 of structured scope identity, last content-event position,
ordered fact ids/revisions, expiry metadata and reviewed selection boundary. Never hash text.
Use stable batchKey = SHA-256(JSON [silo, scopeId, UTC date, inputRevision]); record the components.
Separately derive nightId from [silo, scopeId, UTC date]. Claim that night with one conditional
scope append, not SQL uniqueness or pg-boss retention. The first claimed input wins: a changed
inputRevision cannot obtain a second attempt or allowance on the same night. Deterministic session,
turn, root, call and correction ids are derived from this recorded claim, never caller-chosen.

### The existing pg-boss trigger

`HandlerRuntime` currently constructs pg-boss with `schedule: false`. Enable its native timekeeper
only in the scheduling host, after queues and workers are registered and the dispatcher manifest
is ready. Register a plain trigger queue, distinct from event-envelope handler queues, then call
`boss.schedule('dream-nightly', '0 2 * * *', {silo}, {tz: 'UTC', key: silo, missed: 'skip'})`.
Use the same database adapter and process in `apps/ops/src/worker.ts`; no Kubernetes CronJob,
OS cron, browser timer or second polling scheduler. pg-boss owns operational schedule rows.
Its 12.35.0 [source](https://github.com/timgit/pg-boss/blob/12.35.0/src/timekeeper.ts) verifies UTC,
minute occurrence deduplication and skip policy. Queue deduplication is only an optimisation.

The scheduled payload does not receive an occurrence timestamp automatically. At trigger handling,
capture the current UTC nightly boundary once and save it in the first durable per-scope intent.
Accept a new scan only from 02:00 to 02:15 UTC; a delayed trigger outside that window records a
missed occurrence and dispatches nothing. Page caught-up dirty-scope metadata at a fixed scan
position; TypeScript chooses candidates and checks existing night claims. Each scope append is
independent. Repeated scans converge on the same night; new content is checked again before release.
Restart scans within the window may complete metadata preparation, never repeat an admitted call.
After downtime skip older nights, leave their facts dirty and schedule the next future boundary.
Display actual intendedAt, selectedAt and startedAt separately. 02:00 is a due time, not a promise
that every scope starts at that instant. A suspended computer may wake; 10–14 seconds is accepted.
Read/revalidate inputs and start a new short authority check after wake, not before waiting for it.

### Checks before any model or memory-tool call

Prepare bounded scope/session/source history with its own deadline first. Then check active owner,
active assistant/audience, membership, actsFor, payer and current recorded requester ∩ assistant
model, MCP, memory-read AND memory-write grants, with applied receipts and live OpenFGA permission.
Require reviewed zero-cost Allow for the memory operation; Ask is a configuration refusal, Block
refuses. Check price/model availability, no earlier unresolved scope run, qualified restricted
runtime and first conservative call cost against root/global/group/assistant ceilings.
Missing/revoked owner or grant, IAM unavailable/behind, unavailable model/provider, unknown price,
missing payer, exhausted budget or an unqualified computer records a reason and dispatches nothing.
Discovery is not a loophole: these preflight failures cause zero model/tool calls and no spend.

Before releasing the turn record owner, assistant, exactly one scope, payer, config revision,
input references, model/provider binding, nightId/rootId and allowanceCents: 100. Use #93's existing
silo budget actor under `budget-leader:<silo>`; never start another BudgetActor in the scheduler.
Allocate through `budget.root_allowance_set`, then correlate its accepted event before dispatch.
Allocation is capacity, not a charge or an exclusive reservation. Reserve each actual gateway call
once and check `rootSettledCents + rootHeldCents + nextBoundCents <= 100` with all existing ceilings.
Count actual combined request input and bounded output, including Codex's trusted instructions;
do not substitute UTF-8 bytes for tokens. Refuse if the conservative bound cannot fit.
Keep fresh access checks within two seconds and watch only exact small member, assistant, relevant
owner-group/payer and grant/policy streams (plus existing ownership evidence when needed).
Use the current history-first helpers and bounded lifecycle summaries. No wildcard authority reads,
whole-chat read inside the check, conversation/memory-content stream in the access fence or raised
timeout. Keep `authority.test.ts` and `authority-volume.test.ts` unchanged. Content positions and
expected revisions are separate checks. Readers check access once; normal activity refreshes them.

## 2. An ordinary isolated maintenance turn

The handler requests the existing assistant computer through server admission and bridge/runner.
Create a requester-bound maintenance session and an `agent.maintenance_requested` input event;
never forge `message.posted` as a human request. Extend requested-turn validation narrowly to that
server-recorded intent, using the same membership, token, lifecycle and root checks as interactive
turns and #106/#107 occurrences. Each session/input/start command makes its own conditional append.
A background owner need not be online, but still needs current authority. No scheduler bearer,
system requester, broad service identity or gateway allowlist exception supplies missing rights.
Use a fresh restricted ephemeral Codex process/thread on that assistant's existing computer.
Person maintenance loads only that person's scope; group maintenance uses #97's `shared_only`
preparation; notes maintenance loads only those notes, even when their audience is one person.
Suppress normal multi-scope preferences, privateContext reconstruction, persona memory and earlier
model replies. Use only current same-scope facts and their checked source references, never extract
from current private/shared chats. No personal context enters group or assistant-note outputs.

Choose `frequent_automation` (currently gpt-6-luna) through existing routing/provider selection.
Freeze the admitted model, providerId, binding position, tariff and payer in turn/pass/hold records.
Keep them on renewal, reconnect, settlement and replay. #300's deployment-key refusal still applies:
a provider-bound turn cannot silently use that key route. Wait for #104's qualified dispatch when
that route is needed. Retirement/revocation stops further dispatch; no fallback model/provider.
This is an ordinary gateway model call, not `/providers/.../test` or a server API-key call.

Pass a server-authored maintenance instruction and a labelled JSON data block with ids/revisions.
Validate an output proposing one merge, contradiction flag, expiry or no change. Reject arbitrary
instructions, tool requests, sources, new identities and claims of human authorship. The gateway
permits only the recorded single model attempt and the checked zero-cost correction, with no hidden
second reasoning call after its receipt. Inputs are fixed; unrelated recall cannot expand them.
Use #97's loaded-reference evidence before releasing text; a selective client proof is insufficient.
Keep plaintext, prompt/results, proxy buffers and private reports in qualified non-swappable RAM.
No SOUL.md, rollout, compaction, SQLite, report/outbox text, tool cache, logs or dumps on computer disk.
Keep shell/file/browser/external MCP/plugins/skills/native spawning disabled. No raw model reply
is saved under a conversation key. Source-linked encrypted facts live on the server as #94/#95
allow; “no memory on disk” here retains their boundary of no memory on the computer's persistent disk.
Browser memory remains in RAM with no-store. Failure of #96/#200/#97 canary proof keeps dispatch off.

## 3. Results, source links and deletion

Apply through the existing governed `correct` path, current read/write rights and expectedRevision.
Add a strict maintenance variant, available only to the recorded one-scope turn, with runId,
inputRevision, typed reason and checked source revisions. The server derives command identity and
checks every loaded input plus historical dependencies. A model cannot choose/drop lineage.
The expiry target uses a metadata-only revision proof; it never becomes a usable text dependency.
One correction receipt ends that turn as #97 requires. Do not loop through further proposals using
its now-obsolete context; other candidates remain dirty for a later night. No `memory.consolidated`
emitter is added; correct its registry description to “reserved”, retaining legacy parsing.

| Reason | Checked `memory.corrected` meaning |
| --- | --- |
| merge | Keep one stable unpinned target id, n→n+1, full checked replacement with fresh revision key. Record mergedFrom ids/revisions, original source links and all loaded dependencies except the target's own superseded revision. The target's historical outgoing dependencies remain. |
| contradiction | Preserve both statements, kinds, pins, expiry and sources; add a typed flag and conflicting ids/revisions. Correct one target with its unchanged text under a fresh key. Show the inverse flag through the projection; never pick a truth or rewrite a preference. |
| expiry | Retire an unpinned fact only when its explicit recorded expiresAt is due. Add a payload-free retired variant of corrected: expected/current revision, source references, reason and effective expiry; no old text or replacement key. Hide it and trigger #95 cleanup/invalidation. |

Merge suppression needs a small explicit contract addition: derive source-revision → target links
from mergedFrom in the correction. Exclude those source revisions from ordinary list/search/context,
but retain their support keys and historical dependency metadata until correction/forget/expiry
requires cleanup. Internal lineage checks may use live suppressed sources; this does not grant
human/model recall of hidden duplicate text. Source links show safe merged metadata; Forget can
still address an authorised donor id/revision. Never correct donors merely to mark them merged:
that would supersede inputs and immediately invalidate the target that depends on them.
Retain suppression evidence after target deletion; deleting a merged result does not automatically
republish its suppressed sources. An explicit new human correction can publish a new live revision,
subject to #95's lineage rules. Forget any source: permanently hide that id and all historically
dependent content, destroy their revision keys, remove text/vectors and finish cleanup by event.
Forget the target: its derived text disappears and suppressed duplicate text stays suppressed.
Do not restore aliases during replay, create new ids from deleted text or drop a dependency to fit.
Refuse >32 accumulated dependencies, >8 source links, cycles or oversized commands/events.
Pinned text, kind, pin and expiry cannot be changed by dreaming, merged away or automatically
expired. A content-preserving contradiction flag may annotate a pinned fact; its statement remains
unchanged. Human expiry still excludes it from use, but maintenance does not retire its identity.
No age/last-access heuristic or model judgement expires facts without a recorded expiry policy.
The retired variant is an explicit #99 schema extension: normal #95 replacement validation still
requires future expiry; do not relax it globally to accept stale payloads.
Immediately before correction recheck all input refs/keys/tombstones, projection generation,
config binding and current authority, then append with the checked scope sequence. A concurrent
correct/forget/pin change or expired dependency discards the whole proposal; the due expiry target
is the sole metadata-only exception. Never refresh the proposal’s revision or call the model again. Control events do not count as content changes;
read their latest sequence separately for the conditional append. Reconcile an unknown append by
its original command. A forgotten accepted command stays consumed even after key destruction.

## 4. Events, projections, uncertainty and replay

Add exact schemas, examples, registry, catalogue projection/reaction rows and subscriptions together.
Keep fact/run/config records on `scope-<scopeId>`; request evidence lives on the maintenance session;
budget/call/effect events keep their existing streams. No multi-stream command or SQL business rule.

| Record/command | Durable meaning and reaction |
| --- | --- |
| memory.maintenance_bound / bindMaintenance | Checked owner/assistant/scope/payer/enabled configuration revision; disable initiates ordinary root stop. |
| memory.maintenance_recorded / recordMaintenance | Strict action variants: due, prepared, refused, completed, no_changes, discarded, unknown, missed. Store night/key/input refs, binding, real times, safe reason, root/turn/call/permit references and accepted correction id; no payload. |
| agent.maintenance_requested / requestMaintenance | Server-authored ordinary turn input bound to accepted scope intent/root and task frequent_automation; initialise no transcript text from memory. |
| memory.corrected / correct | The sole fact result; run correlation and typed merge/flag/retired data. #95 handles revision keys, dependency invalidation and cleanup_recorded. |
| Existing root/dispatch/reservation/effect events | Actor admission, use-once call permission, actual usage and safe uncertainty; source of all monetary totals, no copied second spend ledger. |

Register dream-memory for maintenance-recorded due/prepared actions; ignore terminal/control repeats.
Keep its existing scope job key and dispatcher manifest upgrade; receipts alone cannot prove dispatch.
Extend the live memory worker/replay to recognise configuration/run records without decrypting them.
Project current binding, reviewed/dirty revisions, runs and merge/flag metadata with ProjectionRunner.
Include processed id/checkpoint in the same projection transaction. Extend #98's exact audit allowlist
and same-scope related-record filtering, not a broad memory-prefix dump. Payload-free trail links
run → accepted correction/source refs → original call/hold. Names and source access are checked
independently; an admin role alone exposes no personal trail. SQL only stores/indexes TS decisions.
Public states: not configured; enabled but qualification blocked; clean (no run due); scheduled with
next boundary; preparing/waking; running; completed; no changes; refused with safe reason; missed or
skipped overlap; stale output discarded; failed with confirmed application outcome; outcome unknown.
Show fact-change status and money status separately. “Nothing changed” requires checked event
history; “nothing spent” additionally requires proof of no dispatch. Completed correction may still
have cleanup pending or an unresolved usage hold. Check status is GET-only for the same run/call.

| Failure/race | Required recovery |
| --- | --- |
| Duplicate trigger, overlapping schedulers, expired queue receipts | Event-history night claim and stable ids converge; no second root/permit/correction. Queue retention is never the lasting idempotency proof. |
| Crash before input/root/call admission | Reconcile recorded stages. Metadata preparation may resume with current checks; uncertain appends wait. A root/token is never inferred from a queue row. |
| Crash after send authority, lost model reply, lost bridge acknowledgement | #93 use-once dispatch admission burns the original call authority. Mark unknown, stop process/grants and keep reservation held. Never resend, even if no response/event receipt survived. |
| Reply exists only in RAM and process dies before correction | No reconstructed proposal or automatic fresh call. Show failed/discarded if usage/outcome is known, otherwise unknown with held spend. |
| Correction append acknowledged late/lost | Original command/run status reconciles the accepted correction once; key journals follow #95. Never provision a replacement from an erased command. |
| Revocation, budget/root stop, provider retirement, previous night still active | Reuse #93 cancellation and final dispatch gate, including old permits. Skip overlap; unresolved attempts block future dreaming for that scope until evidenced resolution. Other scopes/readers remain available. |

pg-boss's ordinary retries can repeat reconciliation and safe metadata work only. Retrying the
failed original through ops jobs/replay cannot reopen a spent send permission or create a new night.
Release holds only on affirmative not-dispatched evidence. Silence, three-minute timeout, Stop,
month rollover and process loss are not refunds. Late valid usage settles once; conflicting evidence
keeps main's conservative hold. An operator resolves spend using existing evidence-based APIs,
not a dream “Retry” button. Resolution cannot reconstruct missing output or retry that attempt.
Record genuine provider overrun in full, stop/alert and mark the budget-cap claim FAIL; never clamp it.
Offline replay stops readers, scheduling, dispatch and reactions. Fold tombstones, obsolete revisions,
historical dependencies, suppression and run states before decrypting eligible facts. Rebuild memory,
night claims, dirty/reviewed state, audit and budget from events using read-only key custody. Provide
no model/tool/bridge/scheduler/key-provision/delete port to replay; counters must remain exactly zero.
After lost queue tables, recover execution stages from events separately: admitted/unknown work
stays inert; only proved unsent preparation can resume within its original window. Restore requires
latest tombstones/deletion markers before service. Independent chat/backups remain the stated exception.

## 5. Frames, APIs and the phone layout

Reuse MaintenanceTrail, the Memory/Decisions panel, MemoryFactDetail, MoneyCard and ModalSheet.
Add authenticated, no-store `GET /api/memory/:scopeId/maintenance?cursor=` (bounded history plus
binding, dirty/qualification state and real nextAt), and `/maintenance/:runId` (safe detail/status).
Use `POST /api/memory/:scopeId/maintenance/binding` with commandId/expectedRevision for explicit
setup/disable; its original command status uses `/changes/:commandId`. No Run now or retry endpoint.
Require current scope read rights even for payload-free run reads; forbidden/foreign/unknown share
404, invalid input is 422, conflict 409 and unavailable 503. Read access once, require catch-up and
bound pages to 20 rows/16 KiB with requester/scope/generation-bound cursors. No hidden-scope totals.

| Frame | Real API binding and interactions |
| --- | --- |
| MEM-61 | Maintenance GET: no runs yet and actual next nightly boundary, or clean/disabled/blocked state. Scope comes from authorised choices; “scheduled” means configured and scheduling available, not qualification complete. Open an existing run from the dated trail. |
| MEM-62 | Run GET supplies owner member, assistant, one scope, payer, intended/actual times, root allowance/held/settled cents, checked outcomes and source revision links. Links open existing authorised fact/detail and #98 audit reads; no saved text snapshots. |
| MEM-63 | Run status supplies no changes, safe failure, revoked owner/grant, IAM unavailable, unknown price, exhausted budget, uncertain hold or stale discard. Show the applicable outcome, not all example rows at once. Check status rereads this run/call; never dispatches. |
| MEM-62-RM | Same APIs and state as the trail/detail. Static ring/fold, no shimmer/flutter/loop; creases are fully drawn. Words and glyphs still explain running. |

Do not reproduce “owner Sales team” as the execution identity: disclose the recorded member and
separately the group audience. Do not invent €0.18/€0.12 or a sequence of four successful changes
from MEM-62. The initial one-correction batch shows only its actual action, protected pins and
unprocessed backlog; history can show the other outcomes from other dated runs.
Fact/source access is independent. A forgotten source shows safe metadata, no text/preview;
revoked source links disappear. Money comes from the existing root accounting read, authorised
for this scope/run; having a payer role alone does not grant its private memory references.
At 1280px keep the session panel and detail drawer. At 390px use a full-screen overlay with Back,
stack labelled money/status rows and full-width 44px actions. Wrap long scope, member, assistant,
payer and dates with no horizontal scrolling; keep Check status below its explanation when needed.
Restore opener focus and scroll. Trap modal focus on its title; Escape closes, never resends.
Announce start/result once politely, never forgotten text. Clear protected RAM state on requester,
scope or access change and ignore late replies; ordinary fact activity refreshes without closing.

Two additions have no exact supplied frame. UI PRs for these wait for the owner's Claude Design
handoff; their backend/API PRs proceed. The existing four frame mappings do not need a new handoff.
Ready-to-paste prompts follow; they are requests for designs, not calls made by this task.

**Prompt: Maintenance binding review (new frame).**
“Design a nightly memory-maintenance setup/review sheet for OpenCrane 2. Users are the person
owning personal memory, or an authorised group/assistant-note audience member accepting execution
as themselves. Admin status grants no personal-memory access. Purpose: explicitly bind one scope,
active human owner, compatible assistant and paying group before enabling nightly paid work.
Show scope/audience, Runs as [member], assistant, payer, 02:00 UTC, 100 cents maximum per scope/night,
separate existing ceilings and the one-batch/32-fact limit. Show draft, validation refusal, saving,
saved with actual time, stale revision, unknown with original-reference Check status, disabled and
access-changed states. Select only server-authorised options; enable/disable submits once after
explicit cost review, Cancel saves nothing, unknown never resends. No grants, schedule editor or
Run now. At 390px use a full-screen sheet, Back/Cancel, wrapped labels, full-width primary action,
44px targets and visible consequences; no composer/horizontal scroll. Reuse MEM-30/32 forms,
MEM-40 review, MEM-61/62 money presentation, DM Sans/DM Mono, paper/dog-ear/crease, teal #0db5cc,
orange #f47920, ink #16191a, focus #0a8497 and the 06-mem shared status/accessibility/RM rules.
Deliver 1280px and 390px frames and interaction notes.”

**Prompt: Maintenance unavailable and missed states (new variants).**
“Extend OpenCrane 2 MEM-61/63 maintenance trail for authorised personal/group/assistant-note
readers. Purpose: explain why an enabled nightly job has not run, without suggesting paid retry.
Design distinct clean/no dirty facts, qualification blocked, computer waking, missed scheduling
window, overlap skipped, previous uncertain run blocking the next night and provider unavailable/
retired variants. Data: one real scope, due/start/observed times, safe reason, original run reference,
actual settled/held/100-cent allowance, cleanup pending and next future boundary where known.
Check status reads the original reference only. Link to authorised setup, existing run detail or
provider/spending page only when allowed. No retry, invented refund, countdown, hidden counts or
private source text. Preserve loaded data on a safe refresh outage; clear it on access change.
At 390px use full-screen Back, stacked wrapping rows, full-width 44px actions, Check status beneath
its notice and no horizontal scroll. Reuse MEM-61–63/MEM-62-RM, MoneyCard, rice-paper/dog-ear/crease,
DM Sans/DM Mono and teal/orange/green/red/ink tokens from 06-mem. Use glyph plus words, polite
status and frozen reduced motion. Deliver each variant at 1280px and 390px with transitions.”

## 6. Ordered PRs and failing-first evidence

Land serially from green main, server before screens; at most two stacked PRs. Each estimate counts
hand-written additions AND deletions, tests, contracts/docs and branch-named unreleased note.
Each is ≤600; titles/bodies say “Part of #99” until the capability is qualified. Each row delivers
a usable outcome, retaining closed admission for missing prerequisites. Recut a measured larger
outcome before building; do not defer security/replay guarantees to make a diff fit.

| PR / lines | Independently landable outcome; first failing tests |
| --- | --- |
| 1 / 550 | Binding, dirty/run contracts and authorised setup/status HTTP, dispatch disabled. Prove ownership/audience/payer matrix, explicit cost acceptance, changed-command conflict, expired metadata, reviewed prefix/backlog and replay equality with all external ports absent. |
| 2 / 540 | Native pg-boss nightly intent scheduling and visible blocked/missed history, still no computer dispatch. Controlled clock crosses 01:59:59→02:00, two scheduler processes and duplicate delivery produce one scope/date/input key, clean scope produces no intent, late/offline/overlap skips and backlog stays dirty. Use real PostgreSQL/NATS. |
| 3 / 560 | Server-admitted maintenance request/root bound to owner, assistant, payer, task/model/provider and 100 cents; usable prepare/refusal/status, dispatch still off. Budget-cap race, same-night changed revision, lower global/group/assistant ceilings, absent grants/IAM/price, retired provider and #300 deployment-key refusal all fail before calls. Depends on actual #93 root/admission APIs. |
| 4 / 590 | Source-linked maintenance correction for governed one-scope clients: merge suppression, flag/retired variants, pinned protection, original-command status and cleanup. Prove duplicate merge, both-pinned contradiction, no model expiry heuristic, stale correct/forget, donor/target forget after merge, historical lineage and metadata-first replay with zero model/tool calls. Depends on #95 and #97 complete evidence; no scheduler enablement. |
| 5 / 590 | One ordinary qualified computer attempt through bridge/gateway, guarded correction and event-based crash/status reconciliation. Prove simultaneous person/group/notes canaries, fixed inputs, one use-once call despite duplicate/lost replies, stale output discard, operator replay cannot resend, cancellation, late settlement and unresolved-next-night block. Qualification gates control enablement. |
| 6 / 450 | Scope-authorised trail/detail/audit/spend HTTP with source links and safe failure/held states. Prove bounded paging, admin/private refusal, related-scope isolation, no erased payload, catch-up, GET status makes zero calls and rebuilt monetary/status equality. Requires #98 audit/read contracts. |
| 7 / 400 | MEM-61/62/62-RM trail and detail using landed APIs. First UI tests cover actual times/owner, source denial, money separation, empty/loading, late access replies, 390px wrap/focus, keyboard and reduced motion. |
| 8 / 380 | MEM-63 failure/held status plus owner-handed-off blocked/missed variants. First tests prove Check status only GETs, no refund/retry, forgotten text absent, refresh outage versus revoke, mobile focus and no browser persistence. Missing variants wait for handoff. |
| 9 / 390 | Owner-handed-off binding review through PR 1 API. Test compatible options, explicit nightly-cost review, Cancel, stale config, lost reply/original status, disable/stop, inaccessible personal scope and 390px/reduced motion. Wait for handoff. |

Estimate: 4,450 changed lines, above the ticket's 1,200–1,500. Recommend revising the estimate,
not excluding tests/docs or splitting into unsafe partial outcomes. PRs 1–2 can land before #93's
root allowance merges with paid dispatch closed. PRs 3–5 wait for actual root/admission support;
PRs 4–5 also need #95/#97. #328 alone is insufficient. Back-end work does not wait for missing design frames.
Use injected clocks and recording stubs for every automated model/tool test. Pinned pg-boss 12.35.0
exports TestClock; its SQL clock needs setSessionStatements, absent from our current adapter.
Use its test-only adapter/session support so PostgreSQL and JS time agree; no production time
override or sleep-based midnight test. The combined controlled-clock nightly/budget-cap/idempotent-
replay integration spans PRs 2–5: run one dirty scope across 02:00, refuse a bound above 100 cents,
settle an admitted stub call once, duplicate delivery, forget a merged source, rebuild twice with
model/tool endpoints disabled and compare facts/search/run/dirty/audit/budget plus zero calls.
During implementation run required lint/typecheck/test/check:events and affected web checks under
nice -n 10, respecting live-view batch exclusion. Preserve existing authority regressions unchanged.
Qualification uses actual pinned Codex/gVisor, real gateway/OpenFGA/NATS/PostgreSQL on fresh dev
installs, including 02:00 cold wake, canaries during attempted persistence/Stop/crash/reconnect,
long-chat reads, missing-owner/grant/price refusals, held spend and forget-after-merge replay.
Supply dated SHA/image/environment/expected/observed/artefact receipts with PASS/FAIL/PARTIAL/NOT RUN.
Issue #110 reuses these journeys twice fresh; it is qualification, not another API or consolidation PR.

## 7. Open questions and recommended defaults

- Execution owner for group/notes? Explicit binding to a consenting current member as themselves;
  require compatible assistant/payer. No automatic reassignment or admin impersonation.
- Throughput? One ≤32-reference/16 KiB batch and one correction per scope/night initially. This
  obeys #97's mutation-ending rule. Dirty backlog is visible; measure before adding more batches.
- Late trigger? A 15-minute start window, skip older occurrences and retain dirty facts. Never
  backfill paid work or refresh an input key to obtain another same-night allowance.
- Expiry? Only explicit recorded expiresAt; payload-free retired correction with #95 cleanup.
  Keep pinned identity/content; no age heuristic, model-invented date or automatic preference edit.
- Merge donors? Persistent source-revision suppression plus conservative historical dependencies;
  forgetting either source or result cannot automatically republish merged text.
- Unknown attempt across nights? Block that scope until existing evidence resolves uncertainty;
  keep holds, no automatic retry. Resolution releases/settles money, never reconstructs output.
- Missing UI frames? Obtain the two prompts' owner handoffs; proceed with independently usable
  backends. Do not expand this into a maintenance dashboard, schedule editor or Run now control.
- **Outside-the-box cost:** enabled nightly gateway model calls are paid, capped at 100 cents per
  scope/night within all ceilings; many scopes multiply total potential cost. This note authorises
  no paid execution. Keep tests on stubs. Paid fresh-install qualification needs the established
  remaining shared 500-cent envelope and provider cap; absent that, paid evidence is NOT RUN.

No product code changed, stack started or test run. This proposal's runtime evidence is NOT RUN;
existing memory admission remains disabled until its recorded qualification failures are resolved.
