# Budget exhaustion and uncertain effects

Design for [#55](https://github.com/elewa-git/opencrane-new/issues/55) and
[#56](https://github.com/elewa-git/opencrane-new/issues/56), 10 October 2026, D20–D21. Read-only inspection
on `work/p3-14-design`; HEAD, origin/main and GitHub main were `d53e8e35aa949a9044685259eeda38540628d0c6`.
The worktree was clean. Only this note was written. Tests, builds, stacks, journeys and model calls: NOT
RUN. Network use was GitHub reads only. Historical PASS below means recorded evidence, not a new
verification run or proof of the complete capability.

## 1. What is merged and exactly what remains

Sources: both issues/comments, #46/#54/#53/#93/#107/#108/#63, PRs #71/#114/#186/#192/#328, requested main
modules, evidence/review notes, specs, AGENTS.md, plan, standards, ADRs, catalogue and local handoffs.
Accepted stop-tree design: `/home/jente/.fleet/reviews/p4-11-design.md`.

\#54 is closed: #71 delivered budgets. #46 remains open; its comments report merged
back-end slices but unfinished screens/qualification. Reuse its live approval path;
do not claim the whole blocker is closed. #93 remains open; its accepted defaults
include two seconds to start cancellation and ten seconds to end isolated processes.
Open #328 records delegation contracts/replay only: no root allowance, dispatch gate
or stop-tree implementation has landed through that PR. Coordinate ownership now.

| Issue / every acceptance criterion | Main status | Merged PR and test evidence; work left |
| --- | --- | --- |
| #55.1 Exhaustion blocks model/provider/MCP dispatch, old reservations, approved-unsent and inherited child work; global versus scoped isolation | MISSING | #71 checks new reservations only. `gateway.test.ts` ceiling races prove admission accounting, not cancellation. Need durable scope stops and the one final dispatch gate shared with #93. |
| #55.2 Bridge interruption and live grant removal; queued call/delayed approval never reaches upstream; dispatched race boundary | PARTIAL | Manual Stop and #46 approval waits exist in bridge/runner. No budget-driven bridge cascade or immediate grant drop. Add recording-upstream races and define hand-off ordering. Existing Stop tests are not exhaustion proof. |
| #55.3 Collect real usage, retain uncertainty; repeated notices neither double-cancel/settle nor erase results | PARTIAL | #114 `reconcile.test.ts`: lost computer plus late usage; conflicting late usage keeps maximum charge/full hold. #186 `actor.test.ts`, `hold-leadership.test.ts`: undispatched release and restored uncertainty. Need the same outcomes during budget cancellation and duplicate notice delivery. |
| #55.4 Rollover/authorised ceiling change admits fresh checked work, never repeats interrupted effects | PARTIAL | #71 `gateway.test.ts`: exact month/day rollover, old hold/group/tariff attribution; `integrations.test.ts`: authorised configuration and races. No permanently stopped old-root identity or exhaustion recovery proof. |
| #55.5 Persistent accessible reason with relevant limit/reset/remedy at desktop/390; real-dependency stop races/replay | PARTIAL | Generic BudgetStopNotice and F5 intercepted visual fixture exist. WRK-40–42/SPD-54 labels in its receipt are not scope-specific implementation. Need typed reasons, complete stop states, real NATS/PostgreSQL/OpenFGA races and fresh-install evidence. |
| #56.1 Final SSE/native LLM usage settles original tariff/reservation once, including cached input/write; no whole-body JSON parse | MERGED, live qualification left | #114; `gateway.test.ts` streamed settlement/cache input; `pricing.test.ts` cache read/write rates; `reconcile.test.ts` native usage vectors. Keep these paths alive during exhaustion. |
| #56.2 Missing usage/transport/unknown tariff/lost computer retains full hold and Outcome unknown; duplicate/late/conflicting evidence preserves larger charges | MERGED for model money; exhaustion proof left | #114 `reconcile.test.ts` incomplete evidence, lost computer, unpriceable usage and conflict; #186 actor/recovery/leadership tests. Zero-cost external write truth is separate and still missing under D21/#53. |
| #56.3 Dropped fractional zeros/month boundaries/malformed timestamps never choose period/order; reservation time owns attribution | MERGED | #114 `reconcile.test.ts` six gateway timestamp vectors, cache usage and duplicate ingestion; #71 UTC rollover tests. No new timestamp or FX subsystem is needed. |
| #56.4 Owner/Admin appends evidence-backed effect.resolved with integer amount or non-dispatch proof; Check status reads only; insufficient/conflicting evidence held | MERGED for monetary API; D21 write readback MISSING | #114 `reconcile.test.ts` resolution/refusal; server `integrations.test.ts` HTTP integer/role/Origin/CSRF and held-state checks; #192 `spending.spec.ts` GET-only checks and exact POST. Current evidence kinds are provider_receipt and dispatch_record only. Add requester-bound write evidence with #53, not an admin write retry. |
| #56.5 Two operators/restart/replay idempotence, TypeScript rules, safe desktop/390 resolution view | MERGED source; PARTIAL capability | #114 competing-operator/restart/PostgreSQL rebuild test; #192 web pending/conflict/access-loss tests and 126 visual viewport checks/84 captures. Run two real operator sessions on a fresh install, including exhaustion and lost replies. The issue correctly stays open. |

Verified gaps on main, rather than inferred from ticket text:

- `actor.ts:107–131` appends `budget.exhausted` only when a new reservation cannot fit.
  Its private set deduplicates notices by UTC day/scope; configuration clears the set.
  It is not a dispatch prohibition. `state.ts` does not fold exhaustion into stop state.
- `data.ts:544–548` has only scope and optional scopeId: no limit, period or reset.
- `decision.ts:308–339` approves explicitly zero-priced MCP calls without checking
  exhaustion. Include the special memory-call path in dispatch coverage too.
- `requireOpenReservation`, `actor.ts:133–153`, checks open money and current access,
  not exhaustion. A reservation is not permission to keep dispatching after Stop.
- `budget-stop-notice.html` has no scope, amount or reset date. `chat-state.ts:123`
  recognises one denied decision, not stops of other affected turns. The conversation
  projection supplies only turnId/reason for a model budget refusal.
- `effect.resolved` and protocol evidence accept receipts/non-dispatch only.
  `tool.dispatch_recorded` adds transport evidence; responded does not prove an Odoo write.

Do not rebuild #114 or #192. Remaining #56 work is exhaustion integration evidence, the D21 requester
write-readback boundary with #53, and fresh-install qualification. Named scope pickers, root/routine
spending, search, history and richer attribution belong to #108. Existing review reports concern pre-merge
revisions: main now uses the resolve output, per-permit pending records, preserved budget inputs and GET
checks. They are regression requirements, not grounds to declare those old blockers open.

## 2. Stop contract: events, commands and dispatch

Stop prevents further affected calls obtaining send authority, including zero-cent tools, and cancels
running work. It cannot undo a remote write or guarantee upstream interruption. Stopped execution may
coexist with settled charges and unknown effects.

| Scope | Work stopped and blocked | Work left alone |
| --- | --- | --- |
| Global monthly or global daily safety cap | Every active/admitting/queued root in this silo and its execution descendants, whatever payer/assistant; all model/provider/MCP call send authority | Other silos; authorised readers, viewers and evidence collection |
| Paying group monthly | Roots with this immutable admitted payer, across assistants/requesters, and their descendants; old reservations and approval waits too | Other payers, including other work on the same computer |
| Assistant monthly | Roots executed by this assistant and inherited native descendants, across its payers | Other assistants, even when they share the payer |

Extend exhaustion on the existing `budget-<silo>` stream, preserving legacy replay. Record scope/scopeId,
daily/monthly kind, period start/resetAt, ceilingCents, settledCents, reservedCents, attemptedBoundCents and
configuration reference. Use event id/position as the stop reference. Sum with BigInt; expose safe
non-negative integer cents. Record all binding reasons in one exhaustion event when multiple limits fail.

Keep accepted #93 semantics: fitting reservations can fill capacity without invalidating those calls. A
subsequent over-cap attempt commits exhaustion; zero or a lowered ceiling at/below current settled-plus-held
capacity prohibits dispatch immediately. Do not turn the next refusal into graceful finishing for existing
reservations. An exhausted work identity is terminal even when subsequent settlement frees capacity.

Fold scope stops and affected root identities in TypeScript. Reuse #90/#93's root admission binding and
stopped record; when absent, bind the existing server-admitted turn to the budget position without
introducing a second allowance ledger. Native children inherit root, requester, assistant, generation and
payer; never trust a browser/model assertion of ancestry. A root admitted before the applicable exhaustion
position remains stopped after configuration/period recovery. This ordering must be recorded before token
issue, including turns that have not made a reservation yet. Unstarted queued messages retain a terminal
stop receipt and cannot later become turns.

Reservation, configuration, exhaustion, dispatch admission and settlement run in the same actor queue with
expected-sequence fencing. Each command conditionally appends once to one stream. Configure appends
ceiling_set once; the actor immediately derives the prohibition from that event, and a separate reaction
command records any explanatory exhaustion event. Never wait for that reaction to block a lowered/zero
ceiling. The exhaustion append itself blocks dispatch before fan-out jobs or UI delivery.

Use ONE `budget.call_dispatch_admitted` gate, or the equivalent accepted #93 record. The builder of that
contract owns it for both issues; later PRs extend its callers. Do not add a budget-only gate alongside a
root gate. Bind trusted logical call id, root/turn/thread, body digest, decision/approval reference,
optional reservation id, requester/payer/assistant/generation and current scope/configuration checks. It
changes no cents. Explicitly zero-priced tools pass through it without a fake monetary hold; unknown-priced
tools remain disabled. Managed providers remain disabled unless their existing owning feature enables them;
verification calls use this gate too.

At that final gate, recheck root/scope stop, current budgets and authority after queueing. For an existing
reservation check its binding/open state and current prohibition; do not count its held cents twice or
demand a new reservation. For a fresh call reserve first through the existing actor, then obtain send
authority. A spent decision, stale approval, token renewal or lost reply cannot bypass this operation.
Approval consumption and dispatch are separate stream appends: consume once, save audit, then run the final
gate. Losing the race burns that approval and records no send authority. Cleanup may cancel it, never
silently reactivate or transfer it.

The race boundary is the successful dispatch-admission append and one-use hand-off to the gateway sender.
Before it, exhaustion must prevent queued/delayed/approved-unsent calls reaching the recording upstream.
After it, treat the call as potentially dispatched, even before bytes leave or after a lost reply. An
admitted call may arrive after exhaustion and settle; state this boundary in API/tests. No transaction spans
NATS/gateway/upstream. No retry policy or permit reuse: duplicate requests return status, never send
permission. Failure to prove single-use hand-off on the pinned gateway blocks #55 PASS.

Proven unsent calls may release their hold at zero. Use the new gate's durable absence only for calls
governed by that gate, where every sender must obtain it; legacy absence is not proof.
Provider/credential/effect evidence overrides any unsent inference. Remove #186's
expiry-versus-provider-admission race through the SAME serial gate, not a separate release lock. An
ambiguous permit delivery keeps the full hold.

UTC month rollover, UTC daily rollover for the daily cap, or an authorised change to the relevant ceiling
can admit NEW work after every current check passes. Old unknown holds still reduce current capacity. An
unrelated ceiling edit clears no stop. A lowered ceiling above usage does not by itself stop healthy work; a
later call must fit it. An increase never reopens interrupted work or its approvals. Never repeat an
interrupted effect, refund on rollover, change its payer/tariff/period, or dequeue stopped work
automatically. A deliberate new action gets a new work id and approval; unknown prior writes must first be
reconciled to avoid an accidental repeat.

## 3. Where it runs, isolation and recovery

The models decision service owns the actor; neither browsers nor computers keep an authoritative budget
cache. Decision checks use exact bound subjects/summaries. The server reacts to exhaustion by finding
affected unfinished turns from indexed, replayable admission records, then recording root/turn stop and
approval cancellation commands. Key each by source stop event and work id. Repair missing steps through the
existing durable jobs. Do not scan every conversation during an access check.

Extend bridge Stop delivery with original reason/reference and exact affected work. Reuse bridge.ts,
bridge-conversation.ts and bridge-approvals.ts for connected and reconnected turns. Stop delivery has
priority over normal turn delivery/approval wake. At the computer, turn-runner marks the work cancelled,
immediately removes its live model/MCP grants and catalogues, ends approval-holds, aborts active local
streams, then sends turn/interrupt. Main interrupt currently ends waits but leaves grant removal to terminal
release; move revocation to the beginning of this stop path. Reject late start/renewal acknowledgements that
would reinstall a cancelled grant.

Reuse #93 root-specific interruption and isolated-process cleanup. Do not suspend or kill the shared
computer, close a conversation, remove read access or interrupt an unaffected root. Inherited execution
children stop; an independent child conversation with its own root is affected only through its own
payer/assistant/global scope. #107 routine pause/retire and owner/connection invalidation reuse these
operations; no backfill, background descendants, payer substitution or uncertain Run now retry.

Start connected cancellation within two seconds of committed stop; use the accepted ten-second
isolated-process termination bound if interruption does not finish. Dispatch stops server-side immediately;
do not wait for a sleeping computer to wake. The accepted 10–14 second cold resume is irrelevant to budget
safety. Keep offline work stopped, reconcile generation loss, and clear old grants before any new token.
Show Stopping until terminal report/verified exit/loss proves execution ended.

Duplicate notices and reconnects can retry an unfinished interruption; they cannot create another
cancellation result, settlement or dispatch. Keep the first terminal execution result and saved output,
while retaining later usage/effect evidence. Late usage must survive the chat's frozen transcript. Replaying
a projection rebuilds stops/reasons/money with reactions disabled: no wake, model call, tool call or
approval continuation. Normal service recovery separately repairs unfinished cleanup from events.

Lost append replies query the same id/principal/full binding before retrying. Changed payload conflicts.
NATS deduplication windows are insufficient. On restart/leader change, replay scope/root stops and one-use
dispatch records before serving; the first new budget append fences the previous writer. A stale leader,
unavailable store or missing authority fails closed. Crash after hand-off leaves uncertainty, never
resubmission. Crash after resolution append repairs settlement through the existing reaction once.

Keep history and access separate: read history under its own ten-second deadline, then begin the existing
two-second check on small member, assistant, participation, team, payer and grant streams. Check only
relevant new activity for Stop/close/end. No whole-conversation watch, wildcard read or budget-stream
activity in a reader's authorityFence. Reads authorise once after loading safe data. Keep
`authority.test.ts` and `authority-volume.test.ts` unchanged as required regressions. PostgreSQL stores
TypeScript-folded content/checkpoints/indexes; no SQL business rules. Reuse installed OSI components; no new
dependency, public endpoint or finance engine.

## 4. Remaining reconciliation boundary

Exhaustion restricts dispatch, not observation or monetary settlement. Gateway final SSE/native fields,
lost-computer reports, Owner/Admin resolve and settle-budget keep working during Stop, zero ceilings,
restart and rollover. Preserve original tariff, safe integer actual cents, maximum known charge and
conservative conflict hold. If actual usage exceeds its bound, record it fully and alert/stop; never clamp
history. That overrun FAILS the claim that nothing spent beyond its allowance. Qualification must prove
trustworthy bounds on the real path, not treat planning headroom as proof.

D21 assigns monetary evidence to Owner/Admin and external write readback to the requester. Agree this
contract with #53 before its Odoo write is enabled: #53 owns the bounded ordinary-user Odoo read and
write_uid/note/version evidence; #55/#56 own stop identity, safe stored outcome and money integration. A
zero-cent tool can have an unknown effect while its monetary cost is exactly zero. Neither a paid model
receipt nor a generic HTTP response proves whether that tool changed the order.

Add a strict external-effect record keyed by the original trusted logical call/dispatch reference. Reuse
tool transport evidence, add requester-supplied write_readback with opaque evidence id/hash, checked time,
bound operation/argument digest and result changed/not_changed/unknown. Keep private readback encrypted or
referenced outside safe admin metadata. Record one conditional append on its effect stream; do not fabricate
a model reservation so it appears in the admin spending list. Unchanged current text alone does not prove
non-dispatch or that no transient write happened. Changed text alone may be another user's edit.
Conflicting/insufficient attribution remains unknown. No sudo, admin account, alternate profile or write
retry.

Proposed GET `/api/conversations/:id/effects/:logicalCallId` reads saved evidence only. Separate POST
`…/:logicalCallId/readback` records an explicit requester recovery-read request; #53's reaction checks
current Odoo rights and records bounded readback evidence. The command itself only appends. Check status
calls no Odoo, LLM or external action. After exhaustion admit only this reviewed zero-cost exact-target
recovery read, never stopped-agent continuation or a general MCP exemption. Credential/grant loss leaves
unknown.

Keep the current admin monetary routes: GET list, GET permit detail with sequence/CSRF, POST resolve with
Origin/CSRF and expected sequence. 202 records intent, not settlement; 409 conflict/held requires
reread/review, 400 records nothing, 401/403 clears protected data, unavailable/lost reply keeps the command
reference. Two real operators must race same-amount/different-evidence and different-amount commands, then
restart/replay. Only the recorded resolution is applied; the other operator sees theirs was not applied.
Current list/detail use exact budget/effect subjects and ten-second history limits; the older evidence
receipt's whole-log/two-second listing description is not main.

Fresh-install qualification remains NOT RUN: twice on fresh dev state per #63, real
NATS/PostgreSQL/OpenFGA/gateway/bridge/computer, recording model upstream and ordinary-user Odoo fixture,
1280/390 keyboard/reduced-motion evidence. Exercise all three scopes plus daily cap; queued and delayed
approval; handed-off call/lost reply; zero-cost write readback; two operators; rollover/ceiling change;
leader/Pod restart; drop/rebuild projections with zero repeated effects. Record SHA/image digests, durable
event ids, upstream counts and cents as PASS/FAIL/PARTIAL/NOT RUN. Dev first, Helm later.

## 5. Screens, APIs and handoff gaps

Use `/home/jente/dev/design-handoffs/v2/02-wrk/` and `03-spd/`, not their stale apps/opencrane-ui name. Both
widths exist for the listed frames. PLAN.md rows P3-14/P3-15 and its WRK-40–45 gap note need updating in
implementation: #192 is built; scope/reset reports and participant readback still need APIs.

| Frames | API/data/action and precise remaining screen work |
| --- | --- |
| WRK-40/41/42, SPD-54 | Persistent group/global/assistant reason from proposed authorised GET `/api/conversations/:id/budget-stops?turnId=…`, also delivered as safe conversation status through `/ws`. Include stop reference, reasons/limit/reset/remedy, execution status and observed positions. Main's generic notice only approximates these frames. No admin effects endpoint for ordinary requesters. |
| WRK-43 | Same safe stop read plus authorised call-status reference: distinguish held cents, observed charges and potentially dispatched call. Check status GETs the original evidence. Do not say nothing was sent when hand-off exists. |
| WRK-44 | Existing approval cards/decision API plus authoritative stopped lifecycle; show why the delayed approval cannot continue. Remove enabled actions from server state. Generic Enter never decides approval; a late POST cannot dispatch. |
| WRK-45 | New-period/new-config status permits a new explicit checked action. Keep the old stop and unknown effect visible; never restore the old approval or turn. Also needs the ceiling-increase variant below. |
| SPD-01/03/06–09 | #192 built narrow empty/loading/stale/unavailable/access-clearing/mobile-shell states using GET `/api/org/models` and `/api/org/effects`. Broader summary selection/attribution remains #108. |
| SPD-20–23 | #192 built held list, original-reference GET detail, loading/still-unknown/reasons. Running calls have a waiting count and no resolution form. Odoo wording/readback in the original frames exceeds this monetary API. |
| SPD-24–28 | #192 built structured receipt/hash/cents settlement, non-dispatch release, conflicting/insufficient evidence, integer validation and larger settlement. It did not build requester Odoo readback or automatic provider evidence. Do not copy the frame's free-text Reason field into the strict payload. |
| SPD-30–35 | #192 built saving/pending/applied/lost-reply/other-resolution/revision/access-loss, with per-permit pending state and safe evidence. Resolver identity/time are not returned; do not invent them. Both view and resolve currently require Owner/Admin, so SPD-35 cannot retain amounts for a non-admin. Live two-operator proof remains. |
| SPD-50–53 (#108) | Reuse the same stop reasons, actor configuration and payer bindings. Daily and monthly reset differ; unknown price is refusal, never free. Default payer changes only new roots. Correct SPD-51: its October 120-cent hold still reduces November available capacity; at a 20,000-cent limit with no new usage, available is 19,880, not 20,000. No second spending account. |

At 1280 and 390 keep the reason visible in saved transcript and current stop summary, with glyph plus words,
relevant EUR limit, UTC reset or admin remedy. Never dismiss the only explanation as a toast. Wrap long
names and multiple reasons; preserve 44px controls, 2px focus ring, 4.5:1 text contrast, one polite finite
announcement, reduced motion and keyboard focus return. Phone tables become labelled stacked rows; drawers
are full-screen with Back and full-width actions above the safe-area footer. No horizontal scroll or
composer/keyboard overlap. Scope labels need current authorised names or a safe generic label, not a new
\#108 picker. No private totals or links leak.

Missing frame coverage is listed below. These are additions/variants, not missing WRK-40–45/SPD-54 PNG
files. UI PRs for them wait for the approved handoff; back-end PRs proceed. Each quoted prompt is ready to
paste into Claude Design; no call was made.

1. **Budget stop progress/recovery screen**: no specific budget frame for connected
   Stopping, offline/unavailable cleanup, duplicate/lost acknowledgement, multiple
   binding reasons, daily cap or an authorised ceiling increase. Reuse WRK-40–45,
   SPD-54 and #93 THR-62; requester and authorised participants see their own safe data.

   > Design budget-stop variants at 1280 and 390 for the requester and current chat
   > participants. Purpose: explain why work cannot send more calls and whether local
   > execution has ended. Add named variants of WRK-40–45/SPD-54: stopping; confirmed
   > stopped with one held dispatched call; offline/still stopping; unavailable status;
   > daily cap with next-midnight UTC reset; simultaneous global/group/assistant reasons;
   > ceiling increased, new checked work available, old effect still unknown. Data:
   > safe scope names, integer ceiling/held/settled cents, stop reference, resetAt,
   > checked time and actual cleanup status; no guessed counts or private prompts.
   > Check status reads the same reference; new work requires an explicit new action;
   > old approval stays blocked. At 390 stack labelled reasons and amounts, wrap names,
   > use a full-screen detail sheet with Back and 44px full-width actions above the
   > composer/keyboard. Reuse WRK-43 held card, WRK-44 approval, WRK-45 recovery,
   > THR-62 progress and SPD-50 scope language. Use DM Sans/Mono, existing paper,
   > warning, ink, dog-ear and crease tokens; glyph plus words, polite status once,
   > 2px focus ring, 4.5:1 contrast and reduced motion. Add no auto-retry control.

2. **Requester zero-cost write evidence screen**: WRK-31–35 show outcomes but have
   no readback collection/review flow or exhausted recovery-read variant. SPD-24 is
   admin monetary resolution and cannot serve the requester or imply a provider charge.

   > Design an original-call evidence sheet for the requester of a zero-cent Odoo
   > write at 1280 and 390. Purpose: supply write readback after a lost reply, including
   > after a budget stop, without repeating the write. Reuse WRK-31–35 and WRK-15,
   > the 8g review facts and SPD-21/26/32/34 sheet states. Show recorded-only Check
   > status; separate Get fresh readback action; readback in progress; changed with
   > matching requester/version evidence; insufficient/conflicting or still unknown;
   > unchanged text that cannot prove non-dispatch; lost evidence-save reply; already
   > recorded; access/profile revoked with protected data cleared. Data: original call
   > reference, approved operation/target, safe checked time, readback reference/hash,
   > attribution result and zero monetary cost; model holds are separate. No receipt
   > amount, admin credential fallback, raw secrets or write Retry. Only the requester
   > collects evidence; authorised participants get safe recorded outcome without
   > private evidence. At 390 use a full-screen Back sheet, labelled stacked facts,
   > wrapping ids, linked field errors and full-width 44px actions in the safe footer.
   > Use existing DM Sans/Mono, paper/dog-ear/crease, unknown-ring/lock/check tokens,
   > 2px focus ring, polite finite status and reduced motion; never announce private
   > evidence automatically. Explain that Get fresh readback reads Odoo, while Check
   > status reads saved evidence only.

3. **Settling while stopped / corrected rollover screen**: no combined SPD frame
   distinguishes execution stopped from money still settling, zero-cost unknown write
   from a monetary hold, and prior-period holds reducing current capacity.

   > Design Spending variants for Owner/Admin at 1280 and 390, reusing SPD-20–28,
   > SPD-30–35 and SPD-50–53. Purpose: reconcile money while affected execution stays
   > stopped. States: exhausted with final usage pending; recorded resolution awaiting
   > the actor; applied once with work still stopped; two operators' different evidence;
   > late larger charge with full conflict hold; new month with an old hold still
   > reducing capacity; safe linked zero-cost write unknown, with no monetary form.
   > Data: scope/period/reset, limit, settled and held cents separately, original permit,
   > command/evidence reference, checked time and stop reason. Example November limit
   > 20000, settled 0, October held 120, available 19880 cents. Check status is GET only;
   > resolve is explicit receipt/non-dispatch confirmation; links require chat access;
   > no invented resolver name/time, write retry or automatic refund. At 390 stack
   > labelled money/period pairs, full-screen evidence drawer, Back and full-width 44px
   > actions. Reuse MoneyCard hatching, DM Sans/Mono, paper/dog-ear/crease, existing
   > state glyphs, focus/contrast/reduced-motion tokens. Keep private readback out of
   > the admin sheet and label status-read time as Checked, not Confirmed.

## 6. Ordered, independently landable PRs

Land sequentially from main, server before screens, at most two dependent PRs open. The requested split
overrides the whole-feature rule. Each complete limited outcome includes tests/docs/release note within
about 600 non-generated added/deleted lines. Revise estimates before building if needed; never enable an
unsafe partial path or compress code. Share gate ownership with #93/#90 and remove duplicate work.

| Order / ceiling | Complete outcome | Failing-first proof for that PR |
| --- | --- | --- |
| 1 / 550 | Typed scope/period/reason stop fold and actor prohibition, legacy replay and relevant-config recovery. No new dispatch enablement. | Real NATS: global/group/assistant/daily isolation; lowered/zero ceiling; old identities stay stopped after rollover/increase; unrelated edit does not clear Stop; actor failover/replay agrees on cents. |
| 2 / 600 | ONE actor call_dispatch_admitted contract and model/provider sender integration, including old holds and expiry ordering. Reuse #93 equivalent if delivered first. | Queue a reserved model call, exhaust before final gate, then release queue: recording upstream gets zero requests. Race on both sides of hand-off; lost gate reply/duplicate id/stale leader/expiry cannot issue two sends or refund possible dispatch. |
| 3 / 550 | MCP, zero-cost and memory-call integration with the same gate; stopped Ask/renewal refuses. | Delayed approval after exhaustion never reaches recording MCP upstream; pause after approval.used/before gate; zero-price old token refuses; different scope succeeds; no fake hold; native inherited binding fixture cannot escape Stop. |
| 4 / 550 | Server durable affected-work fan-out, priority bridge cancellation and typed reason delivery; reconnect repairs unfinished stops. | Real NATS/PostgreSQL/OpenFGA: multiple roots/payers on one computer; queued-unstarted work; repeated notices/lost bridge reply produce one stop; disconnected computer cannot dispatch; reader/viewer access remains. |
| 5 / 550 | Immediate computer grant/catalogue removal, proxy abort, wait cancellation and isolated cleanup, reusing #93 mechanics. | Hold renewal/start ack during Stop and prove no grant reinstalled/no send; interrupt failure/ten-second cleanup; unrelated root survives; late usage settles once and frozen output/result survives. Recording runner/proxy plus real server dependencies. |
| 6 / 500 | D21 requester external-effect evidence/readback API boundary with #53; strict safe records and GET-only status. No Odoo write enablement here. | Ordinary-user Odoo fixture: lost write reply then readback produces no second write; wrong requester/profile/target refuses; altered/conflicting evidence stays unknown; zero-cost effect distinct from model hold; status sends no upstream request. |
| 7 / 450 | Authorised persistent stop/call status API and conversation projection/protocol, including restart/leader reconciliation. | Real dependencies: role/participant/silo isolation, long history before access, unavailable/lagging reads, lost receipts and effect-disabled rebuild with zero wake/send; unchanged authority test suites retain bounds. |
| 8 / 550 | WRK-40–45/SPD-54 and approved stop-progress variants bound to row 7; desktop/mobile persistent reason. Waits for handoff. | Failing browser cases: every scope/daily/multiple reasons, queued/delayed approval, offline stopping, checked recovery; 1280/390 keyboard/focus/contrast/reduced motion; GET-only status and no replay/new-message retry of an unknown effect. |
| 9 / 500 | Approved requester evidence sheet and stopped-settlement/rollover variants; reuse #192 drawer. Waits for handoff. | Two holds/pending reopen/invalid Enter/lost resolution reply/access loss regressions; requester versus admin evidence boundary; old-period capacity; all new 390/1280 states; status reads never POST or call Odoo. |
| 10 / 550 | Fresh-install journey/receipts and operator instructions for #55/#56/#63; no unfinished feature integration. | First demonstrate missing live assertions, then run twice fresh: queued call and delayed approval have zero upstream calls, all scopes and daily cap, two operators, final usage/unknown/zero readback, kill/restart/leader/replay/rollover. Paid conditions only within an established remaining envelope. |

Planning ceiling: about 5,350 changed lines before reuse, replacing the original #55/#56 estimates for these
remaining outcomes. Native enablement/full stop-tree, Odoo adapter installation and #108 finance screens
remain their owning issues. All server integration races use real disposable NATS/PostgreSQL/OpenFGA, pinned
gateway and recording upstreams; mocks alone cannot establish absence of dispatch. Include both mandatory
zero-upstream races in the combined fresh-install journey. Implementation runs required
lint/typecheck/test/check:events plus relevant web checks under nice -n 10, green CI and at most two
independent review passes. Never overlap a full root suite/fleet batch with live-view qualification. Update
changed package people/robot READMEs/diagrams, event catalogue/registry and branch release notes.

## 7. Open decisions and recommended defaults

- **Trigger:** retain #93's accepted default: valid fitting holds alone do not cancel;
  a refused bound stops the affected scope. Zero/binding lowered ceiling stops at its
  configuration append. A rejected very large request can therefore stop other work;
  confirm this product consequence rather than invent a smaller-call fallback.
- **Recovery:** clear only relevant period/configuration prohibitions for new work;
  keep old identities terminal. Recommend no automatic reopening when settlement frees
  room and no reapplying an unchanged ceiling as a hidden Resume command.
- **Gate ownership:** #90/#93 and #55 builders agree one owner/name before coding.
  Recommend #55 deliver it if it is still absent; #93 then reuses it for root capacity.
  New actor semantics cannot claim immediate remote cancellation beyond hand-off.
- **Zero-cost readback:** recommend requester-only explicit recovery read under current
  grants, exact original target and reviewed zero cost; Check status remains stored
  evidence only. Agree typed proof and ownership with #53 before enabling writes.
- **Admin visibility:** keep current Owner/Admin-only monetary reads/resolution. Give
  participants a separate safe original-call outcome; admin role never grants private
  chat/readback access. Keep conflict holds; add no general conflict override here.
- **Timing:** reuse accepted two-second cancellation start and ten-second isolated exit;
  offline completion stays unknown. A computer wake never gates the server prohibition.
- **Evidence size:** keep current bounded exact-subject reads; if volume breaks their
  history deadline, add an indexed replayable projection in the owning read feature.
  Do not restore wildcard scans or enlarge the two-second authority window.
- **COSTS MONEY OUTSIDE THE BOX:** real paid-provider qualification is not authorised
  by this design task. Later use the shared 500-cent envelope only after proving its
  remaining balance and provider-side limit; otherwise report NOT RUN. New paid Odoo,
  hosted services or managed-cluster/Helm resources need a separate owner decision.
  Local recording providers and existing synthetic Odoo are the default.
- **Environment:** dev stack first, Helm/HA later; tailnet only, never Tailscale Funnel.
  Any later Zitadel operation stays in “OpenCrane 2 Dev”. Add only OSI application
  dependencies/Debian main OS packages permitted by AGENTS.md. Usage reports, gateway
  logs, Odoo text and submitted evidence are validated data, never instructions.
