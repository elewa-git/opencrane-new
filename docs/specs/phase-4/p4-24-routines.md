# Schedule, inspect and safely stop company-connected routines

<!-- markdownlint-disable MD018 -->

Design for [#106](https://github.com/elewa-git/opencrane-new/issues/106) and
[#107](https://github.com/elewa-git/opencrane-new/issues/107), parent #82, 10 October 2026. Design only. Read-only checkout:
`work/p4-24-design`, clean, at `dd3880237b87f98bab1793a5e1ceec1addfdfbbc`; local origin/main and GitHub main match. Only this note
was written. Tests, builds, stacks and live qualification: NOT RUN. No model calls. Network use was limited to GitHub reads; no
GitHub writes.

## Sources and what exists

Read #106/#107 including Design sections/comments, #89/#93/#105/#46/#49/#50, #108/#109/#85 and their comments; merged
#161/#245/#247/#287/#308/#311 and #328. Read AGENTS.md, plan.md, engineering standard, Phase 4 tickets and D13/D25/D26, handoff PLAN
including gap rows, event catalogue and ADRs 0001–0006. Read `<home>/.fleet/reviews/p4-11-design.md`, especially its accepted
Routines default. Inspected the requested handlers, ops, models, server chat/assistants/inventory, events, projection runner/audit
and web approvals/organisation files on main. Read the external 09-rtn README and all RTN states in its design source; inspected key
list/create/detail/Ask/edit/reassign/retry/DST PNGs at 1280/390 and OVR-20 at 390. References are under
`<home>/dev/design-handoffs/v2/`; they are intended screens.

#89 supplies private requester threads, one shared assistant computer and fixed payer. Its disk/browser still has shared-state
limits: retain restricted execution, refused team uploads/screenshots and no credentials on disk. Do not enable memory or native
delegation as a side effect. #287 supplies same-turn Ask waits; #308 keeps decisions requester-only; #311 supplies gateway
non-dispatch evidence and one authorised retry. Ask on main still names `profile: none`: company account binding is future work.
#93's design is accepted. GitHub now reports #328 merged, superseding the task's “in review” snapshot; it adds delegation
contracts/projections, not root allowance, final dispatch admission or Stop-tree execution. Those later contracts gate firing. #105
has no company connection implementation on main and depends on #49/#50 custody. Accepted profile defaults use silo-owned company
custody, verified identity and an explicit selection. No guessed profile or personal/company fallback is permitted. HandlerRuntime
pins pg-boss 12.35.0 with `schedule: false`. Its receipts, per-stream FIFO and dispatcher upgrade checks are useful delivery
machinery, not occurrence truth. Legacy routine schemas contain cron strings and `due {routineId, firedAt}` only. Provider
dependencies report routines absent/unsupported; member inventory reports absence/unsupported history. Audit omits routine events;
`/org/routines` is a placeholder.

## 1. Meaning, permissions and identity

A routine is a saved request with one active member owner, assistant, instructions, explicit company connection and profile, paying
group, and daily or weekly schedule. Store local `HH:mm`, one ISO weekday for weekly, IANA zone, definition revision, schedule
revision, effective time and server-derived next local/UTC occurrence. Store a name and encrypted instructions using conversation
custody; reference keys, never secrets. Choose an eligible team assistant initially; payer must equal its recorded payer and owner
must belong to both the assistant's group and paying group. Do not introduce personal-assistant routines or freely selectable payers
here.

An active member may create for themselves if current OpenFGA `assistant#acts_for`, owner and assistant model/tool resource `#use`,
company-profile use and payer checks all pass. Admin status grants none of these. No create-on-behalf shortcut. Only the recorded
owner edits, pauses, resumes, retires, runs now and stops their run. An active Owner/Admin may pause or retire unsafe work and
reassign a paused routine; they cannot approve it, run it as themselves or rewrite its active root. Reassignment names an active
successor and revalidates their assistant, profile, grants and payer. It stays paused until that successor explicitly resumes.
Ordinary ownership transfer also goes through this admin operation; no unreviewed owner field in Edit.

Add OpenFGA `routine` with silo, owner, `read_metadata` (owner or current silo admin) and `manage` (owner with silo membership);
admin intervention is a separate checked role operation. Project creation/reassignment/retirement tuples and applied receipts from
routine events; rebuild them through existing OpenFGA replay. Retired history keeps permitted metadata readers. TypeScript checks
lifecycle and exact owner as well as OpenFGA. No tuple is changed directly and no routine tuple grants a tool right. Owner sees
instructions/results and their private run session. Admin sees safe setup, owner/account/payer/status and intervention consequences,
not instructions, arguments, private results or session text. RTN-21's full review is only for an independently authorised
conversation participant; a metadata-only admin sees “Waiting for Peter”.

“Runs as Peter” means Peter is the recorded OpenCrane requester, even when offline. “Odoo records Kijani orders bot” names the
verified upstream company account. Freeze owner/member admission id, assistant, payer, profile/connection revisions and narrowed
scopes per occurrence/root. Freeze model/provider/tariff and computer generation at admission through #93. A future replacement
computer cannot revive an old permit. No JWT/session cookie is kept for the owner; system firing derives their current rights from
events/OpenFGA, then issues the existing short-lived bound computer/turn passes.

At firing, after wake, at Ask decision/use and immediately before every model/tool dispatch, including free reads, recheck active
membership, assistant/acts_for, group membership, owner ∩ assistant grants, exact published tool/schema/mode, profile use, verified
company identity/revision/scopes/secret availability, payer and live root. The actor checks `settledCents + heldCents +
nextCallBoundCents <= allowanceCents` alongside global daily/monthly, group monthly and optional assistant monthly ceilings. Reuse
#93 admission: at most 1,000 cents limited by remaining applicable ceilings; allocation is capacity, not a charge. All amounts are
safe integer euro cents. Enable only company tools with zero or verified bounded cost; unmetered paid calls refuse. Unknown prices refuse; no tool charge or model call escapes the recorded allowance. Late actual overrun is
recorded fully and stops/alerts, never clamped to hide spend.

Owner removal, lost assistant/group/grant, Block/quarantine, profile revocation or revision/identity change pauses the schedule and
stops active work. Missing custody, IAM receipts, authority or identity service refuses dispatch and shows Needs input; do not
recover by switching accounts. Price/ceiling failure refuses that occurrence and stops its root; later ordinary slots still need
admission. Restoration never reopens a stopped root or auto-resumes an access-paused routine. Read chat/history/definition facts
first with their own ten-second bound. Then use existing authorityFence for writes/turn starts and existing per-call authority
checks; watch only exact small member, assistant, relevant team/payer and grant streams. Check company/policy revisions through
their exact small control records from #49/#105. Never put growing routine/run/computer/conversation histories into a read fence or
read them under its two seconds. Check Stop and routine control changes separately as execution facts using captured summaries and
bounded incremental reads. Due, files and unrelated turn activity must neither refuse a reader nor invalidate a healthy call. Keep
authority.test.ts and authority-volume.test.ts unchanged; add routine regressions. Deliver routine instructions as labelled user
data, never system/developer authority. Treat tool descriptions and upstream results as untrusted data; they cannot select
credentials, expand grants, change payer or issue management/approval commands.

## 2. Scheduler, occurrences and crash recovery

Add a dedicated `apps/ops` routines worker in the dev process/service configuration. Use a separate pg-boss instance with scheduling
enabled and a dedicated tick queue; leave HandlerRuntime scheduling disabled. Schedule one UTC minute tick, not database cron per
routine. TypeScript calculates local slots, eligibility, skips and next dates. Use indexed routine candidates in batches of 50 and
exact event summaries to decide. Reuse the database leader-lock pattern from models-main with a separate routines key; lose the lock
connection → abort scans/admission. Never hold the budget leader lock. Two schedulers may still race: conditional event appends
provide correctness. The worker has no upstream/profile secrets, model key or browser grants. It submits internal commands through
authenticated silo-scoped paths; it cannot call a tool. Use existing dispatcher/projection credentials as appropriate; add only the
required command path. Keep computers/gateway outside NATS access as ADR 0005 requires.

Use Luxon 3.7.2 (MIT, OSI-approved), already in the lockfile through cron-parser, declared directly in the package which uses it.
pg-boss 12.35.0 and cron-parser 5.10.1 are MIT too. No new scheduler service or time-zone data download. Validate IANA zones against
the runtime; reject unsupported zones. Use local calendar dates, not 24-hour UTC additions. Round-trip constructed local fields to
detect missing times; enumerate ambiguous offsets and choose the earliest UTC instant explicitly. For Brussels weekly Sunday 02:30:
25 October 2026 → 00:30Z once, not 01:30Z; 28 March 2027 has no 02:30 → record DST skip, next 4 April → 00:30Z. Also test daily
across both transitions, non-hour shifts and zones with no DST. Persist each calculated slot/UTC offset and next UTC time;
library/image upgrades cannot alter an already claimed slot. Resume/edit only computes future slots.
Record a DST skip at the clock-change boundary; that recording time can be the next scheduler candidate without a due UTC instant.

Scheduled occurrence id = hash(silo, routineId, scheduleRevision, intended local date/time, zone). Never use delivery time,
scheduler replica, queue id or firedAt. A repeated hour shares one id; a DST skip has the same local identity but no instant. Run
now id = hash(silo, routineId, original commandId, `manual`); it does not advance the scheduled cursor. Definition edits freeze new
content without resetting a slot; schedule edits invalidate unclaimed old slots and begin strictly after effectiveAt. No claimed
slot is renamed, even if pause/edit/resume occurs at the same minute.

On `routine-<id>`, one conditional modern `routine.due` append verifies active definition/schedule and claims the occurrence plus
the sole active-run slot. Include frozen definition references and stable conversation/message/turn/root ids. Compare the current
routine stream position; after conflict reread, recognise the same slot or record overlap skip. Queue/NATS dedupe expiry and SQL
receipt loss cannot create another due: recognise occurrence ids/cursor from event summaries, not retention. Waiting for Ask,
starting and stopping all occupy the slot. Release it only after verified root/tree termination; late money settlement may continue
after release. An ambiguous external effect pauses future firings pending owner review by default.

Allow at most 60 seconds of scheduler lateness to claim a slot. On startup or a late tick, record past unclaimed slots as missed
during downtime; never fire them later. Record startBy = firedAt + 60 seconds in due. A saved due continues only through proven
unsent stages before startBy, with the same ids; later preparation is missed/interrupted and stopped, never activated. Wake may take
the accepted 10–14 seconds; a timely saved due is not missed merely because cold resume finishes later. Recheck authority after
wake, before admission. Record overlap/DST skips and bounded missed ranges with schedule revision, endpoints, count and
deterministic range id. Calculate/count in TypeScript; range cursor CAS prevents duplicate accounting. Expand only the requested
20/50 history rows on reads. Pause/retire stops scheduling; resume records the next strictly future slot and a missed summary where
needed. Process at most 100 past local slots per routine per tick, record a range/cursor and continue later; enqueue no catch-up work.

Due reaction: create one owner-private agent session for that occurrence, post one encrypted system-origin input with owner as
author/requester, then call #93's same root admission using occurrenceId. Existing wake/assistant/bridge paths do execution. Use one
private session per occurrence to prevent cross-owner history after transfer; do not append to an existing human chat or carry prior
private results automatically. Each stage is a separate one-stream command driven by events, with stable ids and full binding
comparison. A saved activation admission consumes sender authority once.

| Crash/duplicate point | Recovery |
| --- | --- |
| Before due; two tick deliveries/schedulers | Recalculate; one CAS claims due, others return its receipt. A late unclaimed slot is missed. |
| After due before session/input | Read exact occurrence ids; append only missing creation/message. Duplicate message delivery cannot add a root. |
| After input before root allocation/turn admission | Reconcile existing message and root/computer records; same root admission and immutable allowance. |
| After allocation before activation admission | No spend yet; resume only after fresh rights/Stop checks, with the recorded root. |
| After activation admission before send/reply | Reconcile bound bridge journal/live turn; never blindly redeliver input. Without proof of unsent activation mark interrupted/unknown and stop. |
| After an external call or missing terminal report | Read dispatch/usage/exit evidence; stop uncertain work, retain holds, never recreate the prompt/root. |

Exactly one due/input/root means durable admission identity, not exactly-once upstream effects. A sender hand-off can succeed
without its reply; classify that uncertainty. Safe retry acts on an exact proven-not-dispatched intent, never “the whole run”. Reuse
#311's gateway `not_dispatched/connection_refused` proof and owner-only unchanged approval.retry_requested while the original
turn/root/approval remain live. Renew a permit once, not the allowance; preserve already settled earlier calls. A stopped, expired
or lost root cannot retry a call. Proven unsent preparation may resume with the same ids. RTN-52 must name this narrower scope and
disable retry otherwise. Run now creates a reviewed new occurrence; if active/stopping it conflicts rather than queues. Unknown
prior work needs an explicit warning/review, never a Retry label.

## 3. Ask and lifecycle commands

Reuse the held same-turn Ask protocol and encrypted use-once review, with versioned company bindings from #49/#105: owner,
occurrence/root/turn/thread, assistant, payer, server/tool/schema/destination, canonical argument digest, connection/profile
revisions, verified account, policy and grant receipts. Show requester, company account, target, consequence and expiry. Default
expiry is the existing 15-minute computer hold, not 24 hours; no approval buys extra time or allowance. Step-up remains bound to
this card. Only the recorded occurrence owner who still has current access may Approve or Deny. Missing consequential fields allows
Deny only. Other authorised participants have no decision buttons; an admin cannot replace the requester. Expiry, Deny, Block,
removal, revised schema/arguments/profile/connection, transfer and retire cancel waits and invoke #93 Stop. A changed body cannot
reuse an approval. Never auto-skip the Ask and continue other steps. Decision, single-use consumption and dispatch are distinct
facts; approved/used is not evidence that the company tool completed. Extend the bridge's checked exact control positions for
routine/profile invalidation. Use a bounded pending-approval projection/index for expiry while owner/bridge is offline; reads of
routine status and offline replay must not invoke main's mutating readApproval. Expiry/cancellation appends belong to live
commands/reactions, then feed the Stop path.

Pause records prohibition first, invalidates waits, then stops active tree; resume requires repaired authority, no still-active tree
and chooses the next future slot. Schedule/name/instruction edits affect future occurrences only; active bindings stay frozen.
Changing assistant/payer/connection/profile uses a reviewed paused edit: record paused new definition plus old-root prohibition,
invalidate old Ask, stop old root and await explicit Resume. Reassign likewise stays paused and ends old authority. Retire is
irreversible for scheduling, stops active work and keeps permitted history. Stop active root leaves the schedule policy separate;
the root itself never reopens. Current owner may Stop a still-stopping old root after reassignment without gaining its private chat.
Record routine.run_stop_requested on the routine stream, then use the system cleanup form of #93 Stop with that verified source.
Original requester Stop still uses the existing conversation operation; neither path needs spend rights. All these reuse #93's one
root Stop operation and its original source event/reason. Durable lifecycle intent may precede budget/bridge cleanup: final
admission/dispatch must read that intent as well as budget.root_stopped so delayed reactions grant nothing. Use #93's actor-ordered
final dispatch gate, including zero-cost tools and old permits. A call handed off before prohibition was observed may complete;
show/charge it. Start connected cancellation within two seconds, terminate its isolated process after ten seconds if necessary. Do
not kill the whole shared computer or another session. Show Stopping until termination evidence; keep uncertain holds and late
settlement.

## 4. Events, reads, status and replay

Keep exact legacy schemas as unversioned replay-only alternatives. Add strict `version: 1` modern alternatives, as delegation does;
reject mixed legacy/modern fields. Do not widen cron or firedAt-only contracts with optional governance fields. Legacy routines show
Needs migration, cannot fire, and require explicit reviewed modernisation (routine.updated version 1 with complete definition and
paused state). Every new type/handler and trigger changes registry plus catalogue in the same PR.

| Event contract | Meaning and live reaction |
| --- | --- |
| Modern routine.created/updated | Full encrypted definition/reference, revisions, payer/profile and next/cursor; update indexed view, IAM where needed, schedule candidates. No direct upstream action. |
| Modern routine.paused/resumed/retired; new routine.reassigned | Reason/source/actor, definition/control revision, affected occurrence/root and next slot if resumed; invalidate waits and invoke Stop where prohibited; project owner tuples. |
| Modern routine.due | Scheduled/manual source, stable occurrence ids, intended local/UTC slot, observed firedAt, frozen definition binding; claim one active slot, prepare one input/root. |
| New routine.occurrence_skipped / routine.occurrences_missed | Exact skip or compact deterministic range, reason, schedule revision, cursor/next; record history only. |
| New routine.run_activation_admitted | Occurrence/root/input references and bound sender attempt; one live activation hand-off. Recovery cannot infer non-dispatch from a missing reply. |
| New routine.run_stop_requested | Current owner or permitted admin's exact active-root Stop intent; invoke #93 Stop without changing schedule or granting old private chat access. |
| New routine.run_finished | Verified execution outcome/terminal evidence, result reference if authorised, root and safe reason; release active slot only after tree ended. No invented success from a timeout. |
| Existing budget/root, computer/agent, decision/tool.dispatch_recorded, approval and effect records | Supply actual admission, waits, Stop, dispatch evidence and settled/held cents. Add strict occurrence correlation/binding through #93, not a second finance ledger. |

Commands append once to one stream; reactions compose stages. No SQL triggers, stored business functions or database cron.
PostgreSQL indexes/rows/checkpoints, pg-boss jobs and receipts are rebuildable views/delivery state only. Use
routines/routine_occurrences plus owner, assistant, profile, provider-binding, active-root and pending-approval indexes.
ProjectionRunner commits rows/checkpoint together. Preserve original ids/positions; root totals come from the budget actor. Routine
states: active, paused (reason), retired, legacy-needs-migration. Execution: scheduled, starting, running, waiting_for_owner,
stopping, succeeded, failed, cancelled, interrupted, skipped/missed. Partial output and unknown effect/held money are independent
facts. First terminal cancellation cannot become success later. Expose observed content/IAM/budget positions; append acknowledgement
is Applying, not Ready. Check status reconciles receipt, projection application and actual run.

Mutations carry commandId, expectedDefinitionRevision and an exact reviewed payload; server reads current stream position and
conditionally appends, returning event/change id and positions. Validate organisation/session/Origin, strict bounds and current
rights. Same principal/subject/id with changed payload conflicts; exact repeats return the stored receipt beyond NATS/job retention.
Definition conflict requires new review. Lost reply → GET original command status, never POST from Check status. Missing or lagging
projection/404 is unknown, not proof of failure. Only verified unchanged failure offers same-id resubmission; changing intent
requires a new command id. For approval decisions add commandId/status receipts to the existing route, preserving legacy callers; a
lost decision reply is read by that id and the original card.

Offline replay adds routines/IAM/audit projection rebuilds only. Stop scheduler, dispatcher and effect workers first; disable
upstream/model dispatch, token issue, wake and approval mutating reads. Projection code never schedules or fires. Handler upgrade
backfill is also guarded: historic dues cannot activate expired/stopped roots. After normal restart inspect indexed unfinished
candidates and exact saved stages; reconstruct missing jobs from events, never trust SQL receipts to prove no effect. Do not invoke
generic ops jobs cancellation as a routine lifecycle operation: it changes delivery only. Repair a failed FIFO original in place; no
redrive after peers.

Replace providerDependencies' routine-* scan with bounded indexed dependant rows: join routine assistant to current
assistant/silo-default provider binding, plus frozen unfinished roots retaining older provider revisions. Return complete/current
position, 20/default 50/max cursor pages, safe ids/status and real counts; legacy history remains unsupported. Do not enable
ordinary managed-provider calls currently disabled on main. Replace memberInventory's routine absence calculation with owner-indexed
routine ids, status, current control revision and active-root refs; exact summaries verify returned rows outside the authority
deadline. Bind destructive review to a projection generation, captured event position and verified ownership revisions, and require
complete pages. Behind/unavailable/legacy data blocks removal/retirement; never claim an empty inventory. #85 must complete
reassign/retire before member removal and verify event receipts; firing/every call rechecks removal even if cleanup is late. Rejoin
gets a new member id. Use #85's ownership review/confirmation contract to close concurrent new-ownership races; if it cannot cover
routines yet, member removal stays blocked rather than trusting SQL.

## 5. Screens, API mapping and missing handoffs

Proposed no-store GETs: `/api/routines?view=mine|all&cursor&limit`, `/:id`, `/:id/runs?cursor&limit`, `/:id/runs/:occurrenceId`,
`/:id/changes/:commandId`, `/api/routines/options` and `/api/routines/attention?cursor&limit` (current owner only). Default 20/max
50; all paths are under /api/routines unless written in full. POST `/api/routines` creates; POST `/:id/commands` accepts
discriminated lifecycle, edit, reassign, run-now and exact unsent-stage recovery intents; POST `/preview` returns validated next
local/UTC times/DST warnings without saving or firing. Linked sessions/approvals use existing conversation routes and participant
checks. Requester Stop uses existing `{id, stopTurnId}`; routine Stop records its own intent and uses the same #93 Stop logic
through system cleanup, preserving the source actor. GET run supplies permitted session/audit/spending links, frozen attribution and
separate settled/held cents, never a fabricated result. /api/org/audit extends existing safe metadata and filters with
routine/occurrence/root/actor/time references for #109; #108 consumes those same ids/totals. No second generic change ledger or
status service.

| RTN frames | Screen and server contract |
| --- | --- |
| 01–02, 06 | /org/routines empty/list/long names from authorised paginated GET; all is admin metadata, mine is owner work. Empty only after a complete read. |
| 03–05 | Create options, preview, POST, original-command status; show Runs as, verified company account, fixed payer and actual missing prerequisites. |
| 10, 14 | Detail/next/recent reads with load time/revisions and real dated evidence; instructions owner-only. |
| 11, 11-RM, 12–13 | One run row per occurrence, actual lifecycle/result/money, authorised links; unknown Check status reads only. Do not show multiple frame stages as separate runs. |
| 20–24 | Existing bound approval GET/POST/status; original owner buttons, authorised other-reader waiting, expiry/invalidation, inline linked private chat. |
| 30–35 | Reviewed pause/resume/schedule edit/retire/reassign commands and receipts; generic conflict unless actual actor/time is supplied. |
| 36, 40 | Root Stop and safe access/budget reasons; stopping versus ended remains distinct, held charges retained. |
| 50–53 | Recorded skip/missed ranges; reviewed new Run now; exact intent safe retry; server DST preview with first repeated hour and missing-time skip. |

At 390px use 44px menu/targets, labelled stacked rows, wrapping names/zones/ids, full-screen detail/editor/review with Back, title
focus, Escape and focus return. Use full-width primary actions and a scrollable body; keep last fields/actions clear of safe
areas/keyboard. Chat alone has the docked composer; Enter never approves. Fix visible timestamp/status collisions in RTN-10/13
recent rows; do not preserve frame clipping. Glyph plus words, finite polite announcements, clear protected DOM and discard late
responses on access change. Freeze loops/entrances under reduced motion.

Gap review: RTN-02 already frames a basic admin register; OVR-20 already frames a routine paused row and Routines filter. Neither is
wholly missing. Their admin privacy, full role states and routine-specific history detail need additional handoff. RTN-32 edits
schedule only; RTN-20 begins after the owner found the request, not while offline. UI PRs for the following gaps wait for the
owner's handoff; back-end PRs proceed. Each quoted paragraph is a ready-to-paste Claude Design prompt; no model is called here.

**G1 — Returning owner's waiting Ask.**

“Design how a routine owner discovers an Ask after being offline and on returning to workspace; members need this without Admin
navigation. Show no pending work, one/many waiting, live expiry, expired/stopped, connection invalidated, loading, unavailable,
stale read and access revoked. Data: safe routine name, owner, occurrence reference, company account, request time/expiry, count
only from a complete authorised read. Open the exact run/chat/card, never approve from a notification; Check status only reads.
State ‘No email or push notification sent’; nothing implies offline delivery. At 390px use a compact workspace notice and stacked
attention list, 44px targets, full-screen detail with Back and keyboard-safe composer. Reuse RTN-20–24, WRK waiting header, OVR task
rows, DM Sans/Mono, teal #0db5cc, orange #f47920, ink #16191a, plain paper cards/dog-ear and reduced-motion tokens. Supply 1280/390
role states.”

**G2 — Edit more than schedule.**

“Design owner editing name/instructions, assistant, company connection/profile and fixed payer, alongside daily/weekly local
time/IANA zone. Show authorised choices, legacy Needs migration with reviewed paused conversion, missing/personal-only profile,
changed account/scopes, invalid fields, active run, paused-required identity change, future-only review, conflict, applying,
confirmed, safe failure, unknown Check status and revoked data cleared. Data: old/new definitions, real revisions, Runs as, verified
account, payer, next local/UTC slot and DST warning. Account/assistant/payer changes stop old work and leave schedule paused; no
rewrite of active root/Ask. Review then Save, Cancel returns focus; ownership uses separate reassign. At 390px single-column
labelled scroll body, full-screen editor/review, full-width 44px actions clear of keyboard. Reuse RTN-03/04/32/35/53 and their DM
fonts, paper/dog-ear, teal/orange/ink, focus ring #0a8497 and reduced-motion tokens.”

**G3 — All routines and admin intervention privacy.**

“Extend RTN-02's admin register to All routines and owner My routines. Users: active Owner/Admin managing safe metadata, ordinary
member managing their own, revoked viewer. Show owner/status filters, bounded pagination, empty/no matches,
loading/stale/unavailable, paused after departure, retiring/stopping, read-only, unknown command and access cleared. Data: routine
name/id, owner, assistant, company account, payer, next local/UTC run, reason and checked time. Metadata-only admins cannot see
instructions/results/Ask arguments or approve/run as another owner; offer reviewed pause/retire and reassign only for paused work.
Read-only notices name needed role. At 390px labelled stacked rows, wrapping filters and 44px menu, full-screen intervention with
Back/focus return. Reuse RTN-02/06/30/33–35/40 and OVR-07/08; reuse DM fonts, rice-paper main/plain cards, dog-ear,
teal/orange/green #2a7d4f/red #c1392b/ink and frozen motion tokens.”

**G4 — Routine-specific Change history details.**

“Extend the existing routine row and filter in OVR-20; do not redesign their shell. Users: permitted admin viewing safe
change/dispatch metadata and owner opening an independently authorised run. Design creation/edit/pause/resume/reassign/retire,
missed/DST/overlap, Stop, denied/used Ask and uncertain effect details. Data: actual actor/event time, source,
routine/occurrence/root/command references, decision versus observation, settled/held cents, confirmed versus applying positions. No
instructions, arguments, credentials or private results. States: loading, no matches, restricted links, removed actor, missing
correlation, stale/unavailable, unknown and access cleared. Check status reads original id; Open run/session rechecks rights. At
390px wrap timestamp above row content, full-screen details/Back, 44px controls and no horizontal scroll. Reuse OVR-20–24/20-RM,
RTN-12/13/40/50, SPD money cards, DM fonts, plain paper/dog-ear, teal/orange/ink and glyph-plus-word reduced-motion tokens.”

## 6. Ordered, independently landable PRs

User-requested slices override the usual whole-feature PR size rule. Every partial PR title/body says `Part of #106` or `Part of
#107`; no issue closes before its live journey. Counts include tests/docs/release note and added/deleted non-generated lines. Target
450–580, hard planning ceiling about 600 per row; split an oversized row before building. These contracts exceed the original
combined 2,200–2,950-line estimate: plan roughly 10,000–12,000 lines including qualification, no consolidated follow-up. Merge in
order, stacks at most two. All back-end rows precede routine screen rows. Before #93/#105 merge, rows 1–4 can land; rows 5–7 can
land with create paused and execution unavailable. Later execution rows need completed root/Stop and profile contracts, not just
#328. Missing capability is explicit. Before row 13, company Ask mode refuses without sending; row 11 also supplies mandatory
access-pause/Stop protection before automatic firing is enabled.

| PR / issue / ceiling | Landable outcome and failing-first evidence |
| --- | --- |
| 1 / #106 / 560 | Strict modern/legacy routine schemas, catalogue and pure folds. Red: mixed payload/forged bindings refuse; legacy replay grants no firing. |
| 2 / #106 / 580 | Local occurrence calculation/preview library. Red controlled-clock daily, weekly, Brussels first-repeat/skip, non-hour DST, invalid zone, backwards clock; deterministic ids. |
| 3 / #106 / 580 | Routine/occurrence projections and offline replay CLI. Red: rebuild equality, duplicate events, terminal freeze, compact missed ranges; forbidden effect spy sees zero calls/wakes. |
| 4 / #106 / 580 | Event-backed routine IAM and checked control commands without execution. Red: outsider/admin cannot act as owner, receipt lag refuses; ownership replay equals live tuples. |
| 5 / #106 / 580 | Paused create/options/preview and command receipt routes. Red: personal/missing profile/payer, changed payload id, lost append reply and status-only GET; execution unavailable before dependencies. |
| 6 / #106 / 580 | Bounded authorised mine/all/detail/run reads and owner attention index. Red: admin private text refusal, paging/no false empty, long chat before check, irrelevant activity preserves readers; unchanged authority suites. |
| 7 / #106 / 580 | Provider/member/integration dependency reads, safe audit joins. Red: real routine counts/ownership, frozen old-provider roots, lag/legacy block destruction, transfer/removal race; no routine wildcard read. |
| 8 / #106 / 580 | Isolated tick worker/lease and durable due/skip commands, firing still gated. Red: two schedulers, stale lease, dedupe-window expiry, overlap CAS, late/down/DST range idempotency under clock. |
| 9 / #106 / 580 | Due → private session → input preparation through existing commands. Red: crash before/after each append, duplicate input, edited/retired due; exactly one session/message and no tokens yet. |
| 10 / #106 / 580 | #93 occurrence-root admission/one activation hand-off and wake. Red: duplicate due allocates once, allocation/send/reply crashes, 14-second wake then revoke, fixed payer/root cents, no replay dispatch. |
| 11 / #106 / 580 | Governed automatic company call and run outcome links. Red recording upstream: exact account/requester, credential spoof/no fallback, free-call revocation, missing tariff, shared cap/late settlement; one attribution. |
| 12 / #107 / 580 | Pause/resume/edit/retire/reassign and P4-11 Stop reactions. Red: pause vs pending/admitted dispatch, two editors, old frozen root, transfer/removal invalidation, stopping/unknown holds, future-only resume. |
| 13 / #107 / 580 | Bound company Ask decision/use, expiry and offline invalidation. Red recording upstream: non-owner/admin refusal, changed argument/schema/revision, Block, 15-minute clock expiry, lost decision receipt, one-use race. |
| 14 / #107 / 580 | Run now, exact safe retry and restart reconciliation. Red: new manual id conflicts with overlap, proven TCP refusal only, one retry, ended-root refusal, no whole-run resend; restart with external calls off. |
| 15 / #106 / 580 | RTN-01–06/14 list/create plus detail facts. Red UI contracts: authoritative preview, fixed payer, duplicate click/original-id status, personal refused, late response purge; 1280/390 keyboard/reduced motion. |
| 16 / #106 / 580 | RTN-10–13/11-RM/40/53 run/money/links and DST. Red: one occurrence row, separate held/settled, forbidden links, no timestamp collision at 390, real unknown state; no fake lifecycle timers. |
| 17 / #107 / 580 | RTN-20–24/30–36 Ask/lifecycle screens on existing APIs. Red: owner-only buttons, Enter never decides, revoked clears, conflict/new review, expiry/Stop and lost receipt reads; 1280/390 focus return. |
| 18 / #107 / 550 | RTN-50–52 missed/Run now/narrow retry screens. Red: skipped has no result, active slot refuses new run, ambiguous outcome no retry, same-id intent retry; 390 long reasons/actions. |
| 19 / #107 / 580 | G1/G2 screens after owner handoff. Red: returning member finds Ask without admin shell, no notification delivery claim, full edit review pauses identity changes; 1280/390 all supplied states. |
| 20 / #107 / 580 | G3/G4 screens after owner handoff, shared with #109. Red: metadata-only admin/restricted links, history decision vs effect, all/mine role changes, cursor filtering, protected late results; phone/reduced motion. |
| 21 / #107 / 580 | Fresh-dev journey and restart/replay qualification, fixes inside owning PRs. Red full path: schedule automatic + Ask, pause/reassign/revoke, unknown effects, exact retry, two schedulers and drop/rebuild; zero extra calls/charges. |

For each behaviour row commit failing tests first, then implementation. Pure contract rows remain disabled until integration. Use
controlled clock, real disposable event store/PostgreSQL/OpenFGA where relevant and a recording local tool/model fixture; restart
between saved stages and rebuild with external calls physically disabled. Required lint/typecheck/test/check:events and applicable
builds run under nice -n 10 when implemented; no full/fleet batch during live-view qualification. Independent review at most two
passes, different reviewing model, batched fix verification. Each PR updates affected human/robot READMEs/diagrams, API/catalogue
and its branch release note. Source-ready records pending journeys; done needs fresh-install live automatic company call, same-turn
Ask, measured revoke/Stop, restart/replay and phone comparisons. Fixtures qualify governance but cannot claim a real paid-model
journey.

## 7. Open questions and recommended defaults

- Owner eligibility: any active member with all required grants may own a routine; team assistants only initially, payer fixed to
  assistant. Broader ownership is later.
- Scheduling lateness: 60 seconds to save due; accepted cold resume is separate. Skip all older unclaimed slots and record bounded
  ranges; no catch-up queue.
- Unknown prior effects: pause future firing until owner reviews evidence. Explicit Run now warns it may repeat an earlier effect;
  Check status never sends anything.
- Edit/transfer: future-only name/instructions/schedule; identity/payer/profile change requires paused review and Stop. Reassignment
  stays paused for successor Resume.
- Offline Ask: durable in-app attention on return, 15-minute expiry/Stop. No email, SMS or push claim. External delivery is outside
  scope and may COST MONEY OUTSIDE BOX.
- Time zones: reuse locked Luxon MIT; add direct declaration, qualify gap/fold logic. Freeze claimed timestamps; do not add
  arbitrary cron/holiday/multiple-time schedules.
- Audit/privacy: admin setup metadata only; full review/result requires conversation rights. RTN-21 needs restricted admin
  presentation; OVR-20 already has a routine row.
- Licence/custody: reuse OSI components and #49's dev Kubernetes Secret adapter. No paid vault/KMS, extra service, public ingress or
  lasting computer credentials.
- Live proof: use zero-cost recording model/tool fixtures on the dev box first. A real external model or paid company API COSTS
  MONEY OUTSIDE BOX and needs separate owner authorisation; this design spends nothing. Tailnet only through serve, never tailscale
  funnel. Any later OAuth test app changes stay in “OpenCrane 2 Dev” only.
- Deployment: dev worker/process configuration first; Helm/production operations later. Do not mark either ticket done from source
  checks, merged slices or static frames.
