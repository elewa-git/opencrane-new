# Spending, company ceilings, admin overview and change history

Design for [#108](https://github.com/elewa-git/opencrane-new/issues/108) and
[#109](https://github.com/elewa-git/opencrane-new/issues/109), Phase 4, parent #82.
Read-only inspection on 10 October 2026, branch `work/p4-26-design`.
HEAD, origin/main and GitHub main: `f972aee1f69897c2c801f37650833a5502120ea4`.
The repository was clean. Only this external note was written. Product changes,
tests, builds, stacks, model calls and live qualification: NOT RUN. Network: GitHub reads only.

Read requested issues/designs/comments, PRs, main modules/tests, AGENTS.md, standards, plan,
ADRs 0001–0006, catalogue, tickets, D13/D27/D28, handoff PLAN/gaps, READMEs and 1280/390 frames.
The accepted root note is `<home>/.fleet/reviews/p4-11-design.md`.
`p4-24-design.md` is absent; #106/#107 supply the routine requirements.
GitHub now reports [#328](https://github.com/elewa-git/opencrane-new/pull/328) MERGED:
delegation contracts and outcome replay exist; root allowance and native dispatch do not.
The latest [#55 owner decision](https://github.com/elewa-git/opencrane-new/issues/55#issuecomment-6101585091)
overrides older stop-note wording: every lowered or zero ceiling stops affected work when saved;
money is for Owner/Admin only. #114/#192 already deliver monetary uncertainty; extend them.

## 1. Money meaning and worked cents

Keep one silo budget actor and its conditional event appends. The PostgreSQL lease
elects a writer; it is not financial truth. Preserve leadership fencing and fail closed
on an ambiguous append. Never use a browser estimate or a read projection to permit spending.
Money inputs, events, totals and JSON outputs are non-negative safe integer EUR cents.
Sum and multiply with BigInt, then check conversion; reject fractions, negatives and overflow.
The existing safe-integer boundary is 9,007,199,254,740,991 cents, not SPD-42's invented maximum.
Format euros for display only. Keep the original model, tariff and rounding for each call.

| Scope | Meaning and remaining capacity |
| --- | --- |
| Global monthly | All silo calls. Ceiling minus this UTC month's settled cents minus all open holds. |
| Paying-group monthly | Calls with that recorded payer, across requesters and assistants; same subtraction. |
| Optional assistant monthly | Calls by that assistant, across payers; same subtraction. An absent cap means no additional assistant limit. |
| Daily safety cap | Global ceiling for the UTC day, using that day's settled cents and all open holds. It is not a daily group allocation. |
| Root allowance | Lifetime capacity for one admitted root and its native descendants, at most the accepted 1,000-cent default and available applicable caps at admission. Subtract lifetime settled and held cents. It is neither a charge nor an exclusive monthly reservation. |

Also treat an absent group cap as no additional scoped limit; show “Not configured”,
never zero or unlimited overall. Available is max(0, ceiling minus settled minus held).
Expose an over-cap amount separately rather than a negative money value. Actual admission
must fit every applicable scope and root. Do not add the scopes together as an invoice.
Each settled call contributes once to global, its payer, its assistant and its root totals.
Root/routine roll-ups include descendants; expanding rows must not add parent totals again.

“Settled” is recorded usage, not necessarily a provider invoice. “Reserved” is the full
open hold, including unknown outcomes from older periods. A conflicting call can have both
a maximum known settlement and its full safety hold: extra capacity protection is not billing.
Attribute settlement to the reservation event's UTC day/month, not receipt or gateway time.
At midnight UTC on day one, start the new month without refunding or moving old holds.
Daily rollover also keeps them. Old roots retain their lifetime allowance and original payer.
Missing model/tool price refuses dispatch; only explicitly priced zero-cost work is free,
and it still passes current authority and the shared stop/dispatch check.

| Worked example | Result |
| --- | --- |
| Group cap 20,000; settled 8,420; held 630 | Available 10,950 cents (€109.50). A 180-cent call adds 180 once to global/group/assistant/root, not a 720-cent bill. |
| Root allowance 1,000; settled 240; held 110 | Accounting remainder 650. A 90-cent reservation fits the root only if every company cap also fits. A second root cannot rely on this remainder. |
| October hold 120; November cap 20,000; November settled 0; daily cap 2,000 | November held 120, monthly available 19,880, today's available 1,880. Late settlement of 70 belongs to October; it releases the hold without adding November spend. |
| Conflicting evidence settles 180 on a 120-cent hold | Preserve settled 180 and held 120 while conflict remains. Safety consumption 300 is not a second charge. |
| Lower group cap from 20,000 to 15,000 with 8,420 settled and 630 held | Accounting room is 5,950, but all affected old work stops on save. Fresh roots may use that room after current checks; old roots never resume. |
| Cap 0, or no usable price | Zero is a hard stop, not removal of the cap. No price refuses; no default zero price. |

Use #55's single hard-stop cascade and final dispatch gate, shared with #93: global/daily
affects the silo, group affects its immutable payer, assistant affects that assistant.
Fitting holds alone never cancel work; a refused hold does. Settlement freeing room never
reopens stopped work. Relevant period/configuration recovery permits fresh work only.
Already dispatched calls still settle; release only proven unsent holds. Record an overrun
fully, alert and stop. An overrun fails “nothing spends outside the allowance”; do not hide it
by clamping. Real upstream bounds remain a qualification dependency, not an observation claim.
Main currently lacks this lowering/dispatch cascade; the catalogue promise is not implementation.

Populate named group and shared-assistant choices from authorised `/api/groups` and
`/api/assistants` reads, with bounded selection pages and current ids/revisions. Recheck
chosen resources at save. No pasted id, union of group members, or guessed private assistant.
Main's assistant list covers shared assistants; show unavailable personal choices until their
owning authorised read exists. Missing/deleted choices require reselection, never substitution.
Main stores one silo `defaultPayingGroupId` for new personal roots, not Alex's preference.
Label it “Default payer for new personal work”. Shared roots and routine occurrences always
retain their admitted payer; editing that default changes neither. A routine reassignment,
if #107 permits it, affects future occurrences only through that feature's reviewed command.

## 2. Drill-down and access

Join only recorded server bindings: audit event id/position → trusted logical call/permit →
reservation → admitted root → delegation parent/child → routine occurrence. Include silo,
assistant, generation, requester and immutable payer in join validation. #93 supplies root
and descendant bindings; #106 supplies occurrence-to-root binding. Never infer ancestry from
titles, time proximity, model headers or equal text. Legacy missing joins say “Attribution
unavailable”; incomplete projection joins say “Applying”, with both observed positions.

Keep decision, dispatch, execution and money separate. Blocked means policy/admission refused;
an allow or consumed approval does not prove dispatch. Dispatched requires the shared gate's
hand-off/recorded transport evidence. Uncertain means a possible dispatch without conclusive
usage/effect evidence. Completed or cancelled execution can still have an unknown hold.
A zero-cent Odoo write can have an unknown effect without a model hold; do not charge it twice.
Admin monetary receipts do not prove the write. Requester readback remains #53/#55/#56 work.

| Reader | What is visible and actionable |
| --- | --- |
| Current Owner/Admin, confirmed by membership events and OpenFGA | Company cents, configured limits, safe accounting/effect references and permitted directory names. Edit ceilings/resolve money through those features. No private work title, prompt, approval text, memory or credential. |
| Owner/Admin with current conversation/scope rights too | Safe root/descendant/routine links and permitted resource names. Opening any result rechecks its own rights. Admin status does not supply these rights. |
| Participant/requester without finance role | Own safe blocked/dispatched/unknown outcome under current conversation rights; no company or root cents. Stop/Ask follow the owning feature's requester/owner rules. |
| Routine owner or memory-scope reader | Only the owning feature's authorised metadata/result; routine edit/Ask and memory changes require its specific edit rights. Neither right implies company finance access. |
| Removed member, other silo, stale IAM or restricted resource | Refuse or show a permitted safe stub. No protected id/title/count/preview/link. IAM unavailable is not an empty result. |

An admin finance row can retain an opaque accounting/audit reference and amounts while
its private resource is restricted. Do not reveal hidden descendant counts or private root ids.
In a permitted task tree use one restricted placeholder without hidden totals. Public group
and directory names come from current authorised reads; removed actors say “Former member”.
Read-only states name “Owner or Admin”, “Owner”, “Routine owner” or “Scope editor” as appropriate.
There is no finance-viewer role on main: adapt SPD-35/OVR-07 to denied finance access, not a new grant.
Carry the latest #55 money rule into #93's proposed subagent reads too: a participant's
execution tree must omit allowance/settled/held/remainder unless they also have finance rights.
Load bounded history first, then authorise the response once. Reads have no authorityFence.
Writes/turn starts use only small member, assistant, team, payer and grant streams for two seconds;
never watch or replay a whole conversation there. Unrelated chat/file activity cannot close a reader.

## 3. Overview, owning reads and history

Propose a read-only `GET /api/org/overview`, default 20/max 50 rows with a stable cursor.
Build typed rows in TypeScript from the finite owning-feature summaries below, not HTTP
fan-out, a wildcard event subscription or a fresh scan of every stream. Add bounded summaries
in the owning feature where its existing read is unbounded. Do not call current listEffects
for overview: it scans budget history and every effect stream. Do not decrypt private data.
Return source/checkpoint/checkedAt and independent unavailable/applying states. Use indexed
reads with a two-second overview deadline separate from access validation; cancel on expiry.
An unavailable source cannot produce “Nothing needs your attention”. A missing feature is
explicitly not available yet; it is not Ready. Do not introduce a task/change truth table.

| Source of rows | Owning reads and action/status boundary |
| --- | --- |
| People/groups/ownership (#85) | `/api/members`, per-person `/access` and `/departure`, `/api/groups`, `/api/ownership`; use bounded current summaries. Invite delivery, membership/IAM applying and role/owner conflicts belong here. Status: `/api/members/:memberId/changes/:commandId`, `/api/groups/:groupId/changes/:commandId`, `/api/ownership/changes/:commandId`; acceptance also has invitation change reads. |
| Models/providers (#104) | `/api/org/providers`, provider detail/bindings, model access reads; retired dependencies, grant applying, missing/stale verification. Status: `/api/org/providers/:providerId/changes/:commandId`, `/api/org/models/:modelId/access/changes/:commandId`. Managed dispatch remains disabled unless its own proof enables it. |
| Integrations/tools | `/api/org/integrations`, per-server tools and discovery metadata; changed catalogue, review required, connection revoked, safe failed configuration. Discovery is not automatic external verification. Lifecycle/tool-policy original-command reads are missing: their owning feature must add them before overview offers recovery. |
| Spending/effects (#108, #55/#56) | Budget summary plus proposed bounded spending/effect summaries; exhaustion, retained unknown holds, stopping. Effect Check status reads `/api/org/effects/:permitId`; ceiling status uses the proposed budget change read below. Money resolution remains the existing reviewed effect command. |
| Publication (#92) | Publication's future safe receipt/summary and its conversation change read, once the owner supplies the event/command binding. No current publication API is implied. No entry is automatically published to a parent. |
| Memory maintenance (#99) | Future per-scope maintenance summary: due/paused/failed/unknown, original root and correction receipt. `/api/memory/:scopeId/changes/:commandId` already exists but requires scope rights; no admin bypass or global private-memory scan. |
| Delegation/routines (#93/#106/#107) | Root/task outcome indexes and future routine/occurrence summaries: interrupted, original-owner Ask, missed/skipped, revoked connection, applying lifecycle change. Their owners supply root/routine command reads; Run now is a new occurrence, not retry. |

Order unknown/interrupted first, needs input second (including drafts/review), failures third,
then Ready with dated evidence. Within each class, oldest outstanding event first, stable
source/event id tie-break. Deduplicate the same underlying problem by recorded source id,
not title. Ready shows verification/result event time, revision and scope, separately from
“Checked at” load time. Stale verification remains stale; GET never performs a paid check.
Show one action per row: Check status, Review tools, View invitation links, Open routine or View evidence,
or a proven safe Try again. These open/reconcile the owning feature; no generic resolver.
Name permitted affected people, e.g. “Alex Kim and Peter Otieno — Sales team”, at most three
names plus a truthful permitted total/link. Use “Restricted work” without hidden people/counts.
An admin cannot approve an owner's Ask or replace their company connection with admin credentials.
After review, that feature alone performs its command; a busy row disables its single action.

Check status retains resource, original command, original binding and owning route. It performs
GET only and respects original-caller restrictions: #301/#309 member receipts are not readable
by another admin; an active demoted caller gets only their minimal receipt, removal denies.
404/not_found, network error, matching later values or elapsed time never prove nothing changed.
Offer retry only after an owning response proves refusal before append/dispatch. Keep the same
id and payload for a safe resend; a revised/conflict-reviewed intent gets a new id and sequence.
Do not replay an external effect or use Run now to disguise a retry of uncertain work.

Expose navigation/read/edit capabilities from current events plus OpenFGA: People & groups,
Models & providers, Spending, Integrations, Routines and Change history. Ownership edits require
Owner; scoped actions require their own rights. Hide unsupported/denied navigation; direct URLs
still authorise on the server and explain the needed role. Change `/org` to overview only after
its read lands. Reuse the #154 shell, shared-state components and access-generation handling.
No health score, Skills & workflows, invented people, timestamps, counts or capability toggles.

Extend the existing audit allowlist/strict schemas, not a second ledger. Common fields:
event id/position/time, type, trusted actor kind/id, safe affected scope, command reference,
decision, observed outcome, reason code, source revision and content/IAM progress where real.
Derive humans from verified command fields/principal, including signed budget `setBy`;
never label a system principal or untrusted `actor` as a verified person. Resolve names through
current permitted directory data. Generic history uses event ids or command digests rather
than copying arbitrary user command strings, emails or evidence references into prose.

| Family | New allowlisted metadata, only when the resource is permitted |
| --- | --- |
| Membership | Invite/join/role/remove operation, affected member, prior/new Member/Admin role, invitation state, safe refusal and content/IAM progress. No invite token or credential. Fresh re-admission never restores old grants. |
| Ownership | Appointment/transfer/step-down, affected owners, preserved last-owner rule and recorded result. Distinguish saved intent from applied ownership/IAM. |
| Child publication | Source/target ids with independent rights, published entry/event id and safe asset count when allowed. No child title, transcript, report or asset access granted by the link. |
| Memory | Scope kind, operation, revision change, job/root receipt and tombstone state. No fact text, embedding, source quotation or forgotten text, even after replay. Restricted scope hides names/ids/revisions/counts. |
| Delegation | Recorded root/parent/child ids, generation, execution outcome, stop reason and separate money/effect state. Restricted children disclose no identity or hidden total. |
| Routines | Lifecycle operation, owner/assistant, allowed connection reference, immutable occurrence/payer/root, due/skipped/Ask/stop/result state. No schedule prompt, tool arguments, connection secret or private result. |

Use indexed date/type/actor/outcome/reference filters, default 20/max 50 anchors, stable
position cursors and bounded paged evidence detail. Main bounds anchors at 50 but not all
related evidence: fix both. Do not claim “Page 1 of 4” without an actual authorised total.
Keep recorded decision beside observation: an allowed decision is not a completed effect.
Render stored names/descriptions/Odoo data as escaped text, never instructions or model input.

## 4. Events, commands, projections and recovery

Reuse `budget.ceiling_set/reserved/settled/period_started/exhausted`, existing effect resolution
and observation events, modern delegation events and each owning feature's lifecycle events.
\#55 owns stop/dispatch contracts; #93 owns allowance/root bindings; #106/#107 own occurrences.
Extend their typed safe fields rather than defining competing admission, stop or routine events.
Publication/maintenance must agree their exact event names with #92/#99; do not invent emitters
such as `memory.consolidated`. Update registry and catalogue together for every contract change.
Every command does one conditional append to one stream. Reactions append their own commands;
configuration cannot also write SQL, settle a call or cancel every root inside one command.

Add `GET /api/org/models/changes/:commandId` against the existing silo budget stream. Main has
commandId/expectedSequence POST but no such GET; refreshing current limits is insufficient.
Return original event/change reference, scope, actor/time and content/stop progress if permitted;
do not mark cancellation finished until #55's recorded termination evidence exists. Full read
requires Owner/Admin. An active original caller who lost that role may read a minimal receipt
only, without cents/scope/people; follow #309's ownership check. Another caller cannot use that exception.
Use replayed ceiling-event command lookup, comparing original actor/silo/full payload. No SQL
command ledger. Keep full budget-stream expectedSequence: reservation churn can cause a genuine
409 even without another ceiling edit. Say “Budget changed; review again” unless editor/time is proven.
Finish prior-command/history loading under its own deadline before starting the write's two-second
member/resource check; actor.configure currently scans history after that check starts. Repair it.
Also remove read fences around group/ownership history before reusing those routes for status.
Keep `authority.test.ts` and `authority-volume.test.ts` unchanged; add route/actor regressions elsewhere.

For #56 resolution, add owning GET `/api/org/effects/:permitId/changes/:commandId` and safe detail
resolver/time for SPD-31–34. Existing permit detail shows the result but cannot identify
which operator's command won. Keep structured provider_receipt/dispatch_record evidence, Origin,
CSRF, expectedSequence and 202→pending reaction→settled/held. No free-text Reason, automatic Odoo
readback or automatic “fresh evidence” fetch. Coordinate this small receipt extension with #55/#56.
Unknown POST replies lock that intent; a later GET of the same current amount cannot unlock it.
Store only safe recovery references where the owning feature permits reload reconciliation.
Abort old requests on navigation/resource/access change; reject late replies and clear protected
data on revocation. Preserve timestamped old data on a plain read failure only while access is valid.

Add only necessary rebuildable spending read indexes: one row per recorded call, original period,
safe joins and per-scope/day/month accounting buckets. Reuse the existing accounting functions
for settled/held/conflict deltas in TypeScript; SQL stores/filters/indexes, never decides money.
This is screen data, not admission authority. Keep original reservations and budget stream intact.
Extend auditTrail/audit-rebuild and existing outcome indexes; overview is an authorised read of
those summaries. Commit rows/checkpoint together, shadow-rebuild and swap as existing rebuilds do.
Replay restores exact totals, joins, history, outstanding tasks and source positions; checkedAt
is a new read time. Replay runs no reactions: zero model/tool calls, routine firings, invitations,
approval continuations or budget changes. Startup separately repairs recorded pending reactions.
Lost append acknowledgements query original ids; repeats return the same saved result after the
NATS dedupe window. Changed payload/principal conflicts. An ambiguous dispatch stays held forever
until evidence resolves it; retries never manufacture another charge or send authority.

## 5. Screens, API mapping and handoff gaps

All proposed routes below are new reads, not claims about main. Use strict typed query/response,
no-store and current access. Proposed `/api/org/spending` pages calls/roots/routine occurrences
by permitted scope, UTC month, safe reference and cursor. `/api/org/spending/:auditId` gives bounded
safe joined detail; resource links appear only with separate rights. Proposed `/api/org/spending/impact`
reads #55's affected-work index for lowering review, tied to budget sequence and checked time;
it previews counts/names only when permitted and is never a guarantee of the eventual race outcome.

| Screen/state frames | Binding and truthful adaptation |
| --- | --- |
| SPD-01–04, 06–09, 04-RM | Existing GET `/api/org/models`, proposed spending pages, authorised choices. Settled/held/available and daily safety card; empty/loading/stale/denied/unavailable separately. |
| SPD-05 root detail | Proposed spending detail plus #93 root read under conversation rights; #106 occurrence receipt. Gap G2 below. No new allocation/dispatch button. |
| SPD-20–28, 30–35 | Existing `/api/org/effects` list/detail/resolve, bounded summary extension and command receipt. Reuse #192; remove unsupported private work titles, Odoo readback, prose reason and viewer grant. |
| SPD-40–46 | POST `/api/org/models`, proposed impact and budget change GET. Review lower/zero, safe integers, 409, pending/unknown and role loss. Never say “Nothing saved” without refusal proof. |
| SPD-50–54 | #55 stop summary, spending period read, price refusal and default-payer configuration. Correct SPD-51 old holds and SPD-53 silo default; participant SPD-54 omits euro amounts. |
| OVR-01–08, 10 | Proposed overview plus owning reads/status links, shell capabilities, one busy row, dated stale data, partial/denied source and exact-command status. G5. |
| OVR-20–24, 20-RM | Extended `/api/org/history` filters and proposed `/api/org/history/:auditId` paged detail; conversation history remains requester/current-rights scoped. G4. |

At 390 px use a 44 px menu control, wrapping tabs/filters, labelled stacked rows and money
pairs. Panels become full-screen with Back, focus on title, Escape/focus return and visible
full-width 44 px actions stacked above safe-area/keyboard. No horizontal overflow or clipped
second button as in some SPD phone frames. Admin screens have no composer. Participant notices
stay above the chat keyboard. Status uses words/icons as well as colour, polite announcements
without private text, and static reduced-motion states from SPD-04-RM/OVR-20-RM.

The following screens/variants have no adequate frame. Each paragraph is a ready-to-paste
Claude Design prompt, not a request executed here. UI PRs touching these gaps wait for the
owner's handoff; back-end PRs proceed. Retain usable existing frames for supported states.

G1 — Named scope and default-payer chooser; no multi-group/assistant selection frame:
“Design Spending scope selection and the default payer for new personal work for authorised
Owner/Admin users. Reuse SPD-04/40/53 and OVR-08. Show real names/ids, current revision, optional
cap not configured, many choices/search/next page, stale/deleted selection, loading, empty,
unavailable and access loss. Select a group or shared assistant; never type ids or substitute
a payer. Label the default as company-wide and future personal roots only. At 390 px use a
full-screen searchable chooser with Back, stacked labelled choices and full-width 44 px action.
Reuse DM Sans/DM Mono, teal #0db5cc, orange #f47920, ink #16191a, muted #4f575a and existing cards.”

G2 — Routine occurrence and restricted root/descendant spending detail; SPD-05 is insufficient:
“Design safe spend drill-down for Owner/Admin with independent conversation/routine rights.
Reuse SPD-05/20, THR-60–62 and RTN-12. Show audit reference, fixed payer, occurrence/root binding,
allowance capacity, settled/held/remainder, decision versus dispatch versus execution, original
UTC period and source positions. Cover running, Ask, stopping, terminal-with-hold, late evidence,
missing join, projection applying and restricted resource with no hidden ids/titles/counts.
Expand permitted rows and open authorised results; no restart/retry/allocate action. At 390 px
stack the tree in a Back panel. Reuse DM Sans/DM Mono, teal #0db5cc, orange #f47920 and SPD icons.”

G3 — Corrected rollover/default/participant privacy and save-race variants need amended frames:
“Amend SPD-51/53/54/42/46 and SPD-35/OVR-07 for current contracts. Owner/Admin November example:
cap 20,000 cents, settled 0, October hold 120, available 19,880; daily cap 2,000 leaves 1,880.
Link older-period evidence without refunding it. Default payer is company-wide, new personal
roots only. Participant stop notices show safe reason/reset/remedy, no money. Denied finance
names Owner/Admin; role loss after a possible save remains unknown/minimal own receipt, never
claims nothing saved. Integer errors use the safe-integer boundary, not €1m policy. Cover loading,
stale, over-cap and midnight changes. At 390 px stack cards/actions; reuse DM Sans/DM Mono,
teal #0db5cc, orange #f47920 and SPD reduced-motion states.”

G4 — New audit family details have no frames beyond OVR-22's ownership example:
“Design Change history detail variants for membership, ownership, publication, memory metadata,
delegation and routines. Users are authorised Owner/Admin; resource links need separate rights.
Reuse OVR-20–24/20-RM. Show trusted actor or Former member, recorded time, safe event reference,
permitted operation/scope/revisions, decision beside observation and applying content/IAM state.
Cover unknown, blocked-not-dispatched, missing correlation, restricted, stale and revoked access.
Never show prompts, facts, arguments, credentials, forgotten text or hidden counts. One owning
feature link only. At 390 px stack evidence cards in a Back panel; reuse DM Sans/DM Mono,
teal #0db5cc, ink #16191a, focus ring #0a8497 and plain cards with no decorative paper texture.”

G5 — Partial-source overview and original-caller receipt need distinct amended frames:
“Design actionable Overview for current permitted roles, reusing OVR-01–08/10. Show priority
unknown/interrupted, needs input, failures, then dated Ready; one action and permitted affected
people per row. Data includes source/checkpoint, loaded time, real verification time and owning
status route. Cover one unavailable source beside working rows, feature not yet available,
projection applying, busy row, exact-command unknown/conflict, proven unchanged failure and an
active demoted original caller's minimal receipt. No all-clear with incomplete sources, no health
score, private names or generic retry. Check status reads only; separate fresh setup from all-clear.
At 390 px stack rows/menu/Back with 44 px actions; reuse DM Sans/DM Mono, teal #0db5cc and OVR RM.”

## 6. Ordered, independently landable PRs

These estimates include tests/docs; partial PRs say “Part of #108” or “Part of #109”.
None closes its issue early. Server contracts precede screens.
Do not copy this whole note into every PR. Each has Why / Functional outcome / Architecture /
Evidence / Not in this PR, its branch-named unreleased note and relevant human/robot README updates.

| Order / estimate | Scope, prerequisites and failing-first evidence |
| --- | --- |
| 1 / 450 lines; Part of #108 | Budget original-command GET, replayed lookup, history before write check. Can land now. Lost ceiling reply plus later unrelated reservation/edit must not confirm wrong command; repeat after restart/dedupe expiry, changed actor/payload conflicts, demoted caller minimal receipt, removed/foreign caller denied. |
| 2 / 350; Part of #109 | Correct group/ownership GET history ordering before reuse. Can land now. Slow histories over two seconds still read for an authorised caller; revoke before final access denies; unrelated chat activity does not refuse. Keep both authority test files unchanged. |
| 3 / 550; Part of #108 | Bounded authorised scope choices and save-time existence/rights validation. After 1–2; before root/routines. Real groups/assistant ids, removed choice and revocation race refuse, no silent payer replacement, unknown optional cap is not zero. |
| 4 / 550; Part of #109 | Common safe audit actor/time fields, indexed filters, bounded anchors/detail. Can land before blockers. Spoofed actor/private text canaries excluded, stable paging and bounded evidence, replay equals live records, revoked detail denied. |
| 5 / 400; Part of #109 | Existing member/ownership operation metadata and progress. After 4; can land before #85 completes, using merged #301/#309 only. Owner/role race and out-of-order IAM receipts remain applying correctly; removed actor/privacy and replay match. Unmerged member operations remain unavailable. |
| 6 / 400; Part of #109 | Effect original-command receipt/detail metadata, coordinated with #55/#56. Can land now. Two operators with different evidence, lost resolution reply and restart: identify the actual saved command without claiming the loser's result; not_found never permits resend; role/privacy/replay tests. |
| 7 / 500; Part of #109 | Close existing integration/tool-policy status gaps in their owning routes/streams. Proposed `/api/org/integrations/:serverId/changes/:commandId`, original event reference/progress in mutation replies. Can land before Phase 4 blockers. Lost reply, changed payload, stale catalogue, current-role removal and replay; GET never rediscovers tools or sends credentials. No generic ledger. |
| 8 / 550; Part of #108 | Bounded call/effect accounting read indexes and spending/impact contracts. After 1/3 and #55 stop index; can land before #93/#106. Replay equals actor totals for two real payers/assistants, duplicate/conflicting settlement, UTC old holds and late charges; no full-log scan on a page. Stale impact preview never promises exact cancellation counts. |
| 9 / 550; Part of #109 | Core overview/capability read with existing people/provider/tool/spend summaries. After 2/5/6/7/8; can land before full blockers with explicit unavailable sources. Priority/ties/dedupe, source deadline, partial failure prevents all-clear, role/foreign-silo privacy, GET counts zero effects. Missing future status stays unavailable, not a blind retry. |
| 10 / 300; Part of #109 | Publication safe metadata/history/task adapter. After 4 and #92's reviewed event/receipt. Parent-only/child-only reader matrix, asset rights, duplicate publication and replay; no private report/title leakage. Cannot land emitter-dependent part before #92. |
| 11 / 350; Part of #109 | Scoped memory-maintenance metadata/history/task adapter. After 4 and #99 summary/receipt. Private scope admin denial, corrected/forgotten text canaries through replay, failure/unknown hold attribution, no maintenance run on GET/replay. |
| 12 / 550; Part of #108 | Root/descendant spend joins and safe detail. After 8, actual #93 allowance/call binding and #55 gate, not merely #328; also #90 admission prerequisites. Extend actor/gateway races with two real groups, root versus company caps, spoofed/cross-silo ancestry and replay totals. No duplicated parent/child billing. |
| 13 / 350; Part of #109 | Delegation audit/task links from existing modern outcomes. After 4; can land basic outcome metadata now from #328, before #93 execution; root-money links wait for 12. Terminal execution with unknown money, restricted child/no count, missing join and replay tests. |
| 14 / 450; Part of #108 | Routine occurrence-to-root spending adapter/detail. After 12 and #106 firing/binding reads. Duplicate due delivery joins one root/charge, default edit leaves payer unchanged, old occurrence survives reassignment and UTC rollover; replay emits zero firings. |
| 15 / 450; Part of #109 | Routine lifecycle history/task adapter and final source coverage. After 9/14 and #107 original-command reads; #104 grants/dependency reads must also be complete. Pause/revoke/Ask original-owner matrix, skipped/missed ordering, no admin credential fallback/unknown Run now retry; replay matches tasks. |
| 16 / 500; Part of #108 | Summary/choices/period/rollover UI. After 3/8 and owner G1/G3 handoff. Failing UI cases for carried hold math, no money for participant, optional cap, pagination, stale/denied and late responses at 1280/390/RM. |
| 17 / 500; Part of #108 | Edit/review/exact-command recovery UI. After 1/6/8, #55 cascade and G1/G3 handoff. Lower-above-usage still warns/stops, zero, fractions/overflow, reservation-churn 409, lost reply plus later edit stays unknown, proven unchanged retry only; phone keyboard/focus. Reuse #192 effect UI. |
| 18 / 450; Part of #108 | Root/routine drill-down UI. After 12/14 and G2 handoff. Permitted versus restricted links, terminal-with-hold, missing joins, no roll-up double sum, 390 wrapping/Back/access loss. |
| 19 / 550; Part of #109 | Overview/navigation/owning status UI. After 9/10/11/13/15 and G5 handoff. One action/affected names, priority, real dated Ready, one busy row, safe stale data, unknown no POST, original-caller receipt and role loss/late response; no Skills navigation. |
| 20 / 550; Part of #109 | History filters/family detail UI. After 4/5/10/11/13/15 and G4 handoff. All families, blocked versus observed, cursor/detail bounds, actor removed, privacy canaries, stale retention then revoke purge, 1280/390 keyboard/RM. |

When an estimate approaches 600, narrow that PR's complete outcome before coding; do not split
off a failing prerequisite or invent disabled scaffolding. Stack at most two and independently
review/land each green slice. Prioritise 2/4/5/6/7/9 for #109's critical path while blockers progress.
Extend real NATS/PostgreSQL/OpenFGA actor/gateway fixtures: concurrent global/group/assistant
reservation, payer revocation after allow, lowering versus queued/dispatched calls, old holds,
lost leader/reply and replay. Use recording upstreams, not fake races or paid model calls.
Future checks run under `nice -n 10`: lint, typecheck, targeted tests and check:events; builds
where relevant. Never start a root suite/fleet batch beside live-view qualification. Maximum
two independent review passes; the orchestrator lands after review and green CI/main checks.
Feature PRs retain journey hooks/evidence for #63/#110: twice fresh dev installs, two people,
two groups, another silo, real permission removal, restart/replay, zero replay dispatch/firings,
and 1280/390 accessibility comparisons. Source-ready is not capability-done; neither issue is
complete until its fresh live journey passes. This note supplies no new PASS evidence.

## 7. Open questions and recommended defaults

- Personal default versus company default: use the existing silo default for new personal roots.
  A per-person preference needs a separately owned event/read; amend SPD-53 first.
- Personal assistant finance choices: shared assistants now; await an authorised safe owning read,
  never discover private assistants by scanning computers or accepting typed ids.
- Optional-cap removal: absent means no extra cap, zero means stop. Do not add a removal command
  unless requested; retain current set-only protocol and explain this distinction.
- Lowering semantics: take the latest #55 decision literally, including lowering above usage;
  coordinate older accepted note wording before implementation. No second cascade or grace mode.
- Budget conflicts: retain whole-stream expectedSequence and generic review on unrelated churn;
  do not introduce a separate configuration stream just to remove those conflicts.
- Task freshness/size: default 20/max 50, two-second bounded overview read, explicit partial source,
  independent checkedAt/verification times; no arbitrary health thresholds or hidden totals.
- Missing owning status contracts: feature owners add event-native reads; until then omit recovery
  actions. Not_found never turns into safe failure. Preserve original-caller-only receipt restrictions.
- Money outside the box: none for design, implementation fixtures or replay. Paid qualification
  requires the established remainder of the shared 500-cent envelope and provider cap; otherwise
  paid checks are NOT RUN. No paid call is authorised or performed by this note.
- Delivery environment: dev stack first; Helm/HA later. Existing OSI components only, no new
  dependency. Tailnet only, never Funnel. Any later Zitadel change stays in “OpenCrane 2 Dev”.
