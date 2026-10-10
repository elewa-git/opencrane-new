# Delegate within one root allowance and stop descendants

Design for [#93](https://github.com/elewa-git/opencrane-new/issues/93), 10 October 2026.
Design only. Repository inspection was read-only on `work/p4-11-design`.
HEAD, local `origin/main` and GitHub main were
`8ba1d6081452b798356db933ea4cf3146fb1afa6` when read. The worktree was clean.
Only this note was written. Tests, builds, stacks and live journeys: NOT RUN.
No model calls; network use was limited to GitHub reads.

## Sources, reuse and gaps on main

Read #93 including Design/comments; #90 defaults; #106/#107 including Design/comments;
accepted `/home/jente/.fleet/reviews/p4-8-design.md` and `p4-6-design.md`; AGENTS.md,
plan, engineering standard, Phase 4 spec/decisions D13/D25/D26 and event catalogue.
Read the local `05-thr/README.md`, integration plan and THR-60–62 at 1280/390 px
under `/home/jente/dev/design-handoffs/v2/`. Frames describe intended behaviour.
Inspected merged models actor/state/decision/activity/authority/reconciliation,
token issuer, OpenFGA model, computer runner/proxy/config/private launch, server
turn/report/Stop/bridge commands, projections and relevant robot contracts.
Read the native sub-agent spike test and harness ADR as prior evidence only.

Reuse child-chat PRs 4–5 for `budget.root_allowance_set`, `budget.root_stopped`,
root totals, trusted call identity and dispatch checks. Those are accepted designs,
not merged capabilities: main has no root allowance and generates reservation ids.
Main does have serial actor writes, one per-call hold, fixed payer/tariff, BigInt
ceiling checks, late settlement, uncertainty and evidence-based resolution.
Decision tokens accept only `delegation.length === 1`; native children have no safe
admission/report path. Both computer configs disable multi-agent execution; restricted
reports reject collaboration items. The proxy requires an exact thread grant.
Delegation schemas currently name two computers and success/failure only; no live
delegation projection/reaction implements that catalogue promise. Preserve legacy replay.
Managed provider calls remain disabled on main; delegation must not activate them.

Prerequisites: #89 requester/thread isolation, #90–#92 authorised child navigation
and outcomes, plus #88 independent close cleanup. No new executor, budget ledger,
dependency, scheduler or public assistant-creation control is needed here.

## 1. Meaning, limits and visibility

A root is one server-admitted foreground turn, including a child-chat follow-up.
A native descendant is a Codex task/thread spawned within that turn's execution,
using the same assistant, computer generation, requester and paying group.
It is not a summoned child conversation. The human parent/child links from #90
do not prove execution ancestry and cannot transfer money between independent roots.
Do not delegate to another assistant/computer/member or revive an older task thread.

Recommend root depth 0, at most two descendant levels, four admitted children per
parent, eight admitted descendants over the whole root and four active descendants.
Count completed/failed/cancelled admissions towards the eight and the per-parent four;
retry does not consume another slot. Refuse excess before issuing authority.
Native thread creation alone may precede admission; an unadmitted thread can spend
nothing and is promptly closed. These are server limits, not prompt instructions.
Root processes still obey the existing two restricted-root slots per computer;
descendant threads remain inside their root's isolated process, not new private roots.

An active root or admitted descendant may spawn a fresh direct child. Verify native
spawn item id, sender/receiver threads, parent turn and `thread/read.parentThreadId`
through the authenticated bridge and its bound process/generation. A header such as
`x-openai-subagent`, browser ancestry or model-written JSON is insufficient.
Reject cycles, duplicate thread bindings, wrong root/generation, ended parents,
detached review threads and links to another requester's session.
Do not depend on a completed spawn item arriving before the child's first call:
the pinned protocol must supply verifiable early ancestry or admission stays disabled.

Record exact narrowed model/tool/resource/operation/destination scopes and selected
connection/profile references. Child rights are the intersection of its parent's
recorded maximum and current requester/assistant grants, never a union.
Inherited scopes are an upper bound, not permission: every call checks membership,
effective conversation participation, assistant `acts_for`, payer, grants and live
OpenFGA `resource#use`, plus tool policy and approval. Reuse applied-event receipts;
lagging revocations refuse. Root model/provider choice and shared/private content
class remain fixed. No admin, company credential or group label gives extra rights.

Shared-child descendants use only the root's admitted shared context. Private roots
and their native children remain requester-private. Keep memory disabled where current
admission disables it; delegation proves neither shared context nor no-disk isolation.
Initially native descendants use model calls only; enable governed tools separately
only where #89 already supplies a proven narrow path. Never enable shell/file/browser
tools by relaxing the restricted item guard to accept every native item.
Ask still belongs to the original requester and exact descendant call/arguments;
other participants see only authorised safe waiting metadata and no decision buttons.

Current root-conversation readers may see safe task labels, recorded outcomes and root
cents. Apply existing child inheritance/explicit-join rules and OpenFGA `read` before
decrypting any row. Resource narrowing grants no audience or file access.
Native task pages use immutable `/conversations/:id/subagents/:delegationId` routes,
rendering a read-only thread through the existing full-page workspace. They do not
create independently writable conversations or allowances. The panel holds summaries,
not a second transcript. Any actual conversation link uses #91's authorised route.
Restricted rows show only “Restricted thread”, with no id, title, counts, result or link.
Parent-only readers keep #90's generic restricted card; native detail/spend stays in
the authorised root conversation. Do not send raw delegation events on parent topics.
Only the bound requester with current root read access may Stop all; no spend grant
is required to stop. System cleanup can stop revoked work without that human access.

## 2. Money: one allowance, one hold per call

Reuse the actor's silo budget stream. Allocate a root before its first token from
the server's admitted turn/occurrence, never from a descendant or caller-selected id.
Default upper bound is 1,000 cents, limited by remaining global daily/monthly,
paying-group monthly and optional assistant monthly ceilings. Honour #90's reviewed
upper bound or refuse/re-review a lower amount; require the first conservative call
bound to fit. Allocation promises no exclusive global capacity and charges nothing.
Freeze requester, root turn/thread/conversation, assistant/computer generation, payer
and allowance. New serial work after tree termination gets a new admitted root.
Retries, reconnects, leadership change, configuration changes and rollover retain it.

Do not allocate fixed child pots. Split holds by actual call id: each parent/child
reserves its measured worst-case call bound from the shared remaining capacity.
There is no unused child pot to strand. A completed child's unused reservation
capacity returns through the same settlement path and is available to siblings.
At one serial reservation append check both:

`rootSettledCents + rootHeldCents + nextCallBoundCents <= allowanceCents`

and all existing global/group/assistant ceiling checks. Use safe integer cents,
BigInt sums and existing conservative request-cost rounding. Root totals span its
whole life, not the current budget period. The same reservation contributes to every
applicable total; none of these totals adds a second hold or provider charge.
Zero-cost tools still need a live root/authority check even though they reserve zero.

| Worked example, all amounts in cents | Result |
| --- | --- |
| Allowance 1,000; settled 240; held 110 | Remaining 650: THR-60's EUR 10.00 / 2.40 / 1.10 / 6.50. A 651-cent call refuses. |
| Two children concurrently request 400 and 300 with 650 remaining | First serial append holds 400; second cannot fit the remaining 250. No 700-cent admission. Refusal stops the root and disables any unsent earlier permit. |
| Root starts with zero used; call bounds 300 and 200 | Held 500, remaining 500. First settles at 180: settled 180, held 200, remaining 620. Second settles at 120: settled 300, held 0, remaining 700. Charge 300 once, not 800 or 1,300. |
| Silo daily remaining 500, group monthly 250, assistant monthly 180 | New root admits at most 180, subject to review. Even with more root capacity, a later 181-cent call refuses whichever ceiling binds. |
| Stop with settled 240; one 110-cent unknown call; one proven unsent 90-cent call | Release only 90. Settled stays 240, held 110, accounting remainder 650. Root remains stopped: remainder cannot fund a restart. |
| Late verified usage says the unknown 110-cent call cost 70 | Settle once: settled 310, held 0, remainder 690. Duplicate report/reaction/replay leaves these figures unchanged. |
| Conflicting evidence for a 110-cent call says 70 then 90 | Preserve maximum known settlement 90 and the full safety hold 110 under existing conflict rules. With the earlier 240, remaining is 560. The extra hold protects capacity; it is not another charge. |

Release at zero only with proof of no dispatch: no returned permit, actor/audit
refusal or verified dispatch evidence. Silence, timeout, Stop, closed chat and a dead
process are not proof. Preserve the three-minute uncertainty path and original
model/provider/binding/tariff/payer attribution. Ordinary late complete evidence
settles once; conflicting evidence remains held under existing reconciliation rules.
Do not invent automatic conflict resolution or erase a hold to make a root look done.

If provider usage exceeds a reservation, record full actual cost, alert once and stop
the root; never clamp actual spend to its allowance. Current request estimates include
planning headroom, not a provider guarantee. “At most admitted spend” qualification
must demonstrate the bound at the real dispatch path; an overrun fails that claim.

## 3. Stop-tree, dispatch and recovery

Use the same stop path for requester Stop, root/ceiling refusal, revoked access,
conversation close and routine pause/retire/invalidated approval. Preserve the original
reason/source event. A stopped root never reopens, even if rights or money return.
Stop root execution and every registered/preparing/active descendant, including
reserved-but-undispatched calls. New native reports cannot escape a stopped root.
Closing a human parent does not stop an already activated independent child root;
closing a root's own conversation stops its tree. Never append `conversation.closed`
for Stop, descend through chat-parent links, suspend the whole computer or close
another person's session. Archive/read markers have no execution effect.

First commit durable Stop intent, then revoke grants/approval waits and interrupt
registered threads through the existing bridge/runner. Fold `budget.root_stopped`
through the actor. Admission and gateway checks also read original Stop/close/
revocation evidence, so a delayed reaction cannot keep an old reservation usable.
Recheck after actor queueing and immediately before dispatch, including zero-cost
tools and use-once approvals. Reuse PR 5's trusted one-use call/dispatch identity;
neither an old permit nor a new token may send another call after stop prohibition.

Reservation is not dispatch. The dispatch gate must durably distinguish an unsent
call from authority already handed to a sender. Stop and dispatch admission must
have a defined order in the same actor serial path. Add `budget.call_dispatch_admitted`
if PR 5 has no equivalent durable record: one append binds root/call/body/permit and
consumes its send authority once after fresh stop/ceiling checks. Zero-cost tools
use the same gate without a monetary reservation. A retry reads evidence, never sends.
Already handed-off calls are potentially dispatched and remain held if cancellation
wins before a reply. Do not claim a transaction across Stop intent, budget, bridge
and provider. A call admitted just before Stop may complete; it is shown and charged.
If PR 5 cannot prove a final gate for old permits, fix it before native enablement.

Track active proxy requests per thread/root and abort their local HTTP streams on
Stop. Interrupt native turns, cancel waits and drop catalogues/grants without waiting
for token expiry. Closing a stream may reduce further spend; it cannot undo an effect.
Use root-specific private-process kill/cleanup if interruption fails, without killing
the shared computer process or other roots. Verify exit/thread disappearance through
existing unload bounds. Retain suspend protection until terminal reports, verified
process exit or loss/replacement of the bound computer generation prove execution ended.

Target no new dispatch once prohibition is observed; start connected cancellation
within two seconds of committed intent and use a ten-second interrupt deadline before
isolated-process termination. Measure both independently. Offline roots show stopping
until loss/exit is established; do not report a guessed completion time or promise
the upstream service stopped. Unknown effects and holds may remain after “Stopped”.

Recommend no background descendants after the root agent finishes. Its terminal
report stops any unfinished tail; cooperative roots wait for children before finishing.
Keep the conversation's foreground slot until actual tree termination, not the first
parent completion/interrupt acknowledgement. Keep parent result, tree cleanup and
money state separate. A successful parent output can coexist with cancelled children.
This extends #90's terminal stop rule without giving descendants a new allowance.

On normal restart reconcile admitted descendants, stop intent, missing terminal
computer/agent records, grants and held calls from verified events. Use existing jobs
and indexed unfinished candidates, not only open conversations or sockets.
Restricted processes lost in a crash fail; never recreate them by replaying a prompt,
spawn or uncertain tool call. Safe recovery resumes only proven undispatched stages
with the same ids. Late reports retain digest/sequence checks and acknowledge safely;
stopped text/status stays frozen while raw execution evidence and late usage survive.
Offline replay rebuilds projections/IAM/budgets with all effect reactions disabled:
zero child spawn, token issue, computer wake, routine firing or upstream call.

## 4. Events, commands, projections and retries

Each command makes one conditional append to one stream. Reactions sequence missing
steps; SQL stores TypeScript-folded projections and job receipts, never business truth.
Extend strict schemas, registry ownership, catalogue triggers and protocol together.

| Contract | Stream and recorded facts |
| --- | --- |
| Reused `budget.root_allowance_set`, `budget.root_stopped` | `budget-<silo>`; immutable root binding/allowance, terminal dispatch prohibition and verified source/reason. Extend binding for occurrence references without implementing scheduling. |
| New `budget.call_dispatch_admitted`, unless PR 5 supplies an equivalent | Same budget stream; root/delegation/call/body digest, optional monetary reservation and decision/approval references. Records one potentially dispatched attempt, changes no cents and grants no retry after hand-off. |
| Extended `computer.turn_started/closed` | `computer-<assistant>`; explicit native-descendant alternative binds root, parent delegation/turn/thread, new child turn/thread, generation, scopes/content class and spawn evidence. No fabricated human message. |
| Extended `delegation.started` | `delegation-<id>`; verified modern binding, computer admission reference, root id, requester, assistant, payer, parent/child turns/threads and narrowed scopes. Legacy two-computer shape is replay-only and grants no native authority. |
| Extended `delegation.completed` | Same delegation stream; actual completed/failed/cancelled outcome, safe reason, terminal report/exit references and saved result reference if present. Spawn-tool completion is not child-task completion. |
| Existing Stop and terminal reports | Root conversation intent; extend report routing for recorded native child turns with delegation references and encrypted saved output. Preserve report order/digests; descendant terminal reports cannot finish the root prematurely. |
| Extended `budget.reserved`; existing settlement/effect/decision/tool dispatch events | Record root/delegation/trusted call/body digest in the single call binding. Existing effect/decision ids identify spend and observed/uncertain dispatch; settlement still uses verified event references, not supplied amounts. |

Use the computer stream's conditional descendant-start append to enforce tree depth,
total/fan-out/active limits across server replicas. Fold all native start/end records
for that root there; two independent delegation streams cannot safely enforce a total.
Reload and revalidate on conflict. Append descriptive delegation start separately;
issue no token until both records agree and root/authority checks still pass.
Extend decision activity checks: root Stop/close ends descendants; unrelated task,
message, turn and file activity does not invalidate another reader or healthy root.

Server operations: admit root (reuse), admit verified descendant, record descendant
outcome, stop root (reuse) and read root/task status. Keep native admission on the
authenticated bridge; expose no browser “claim parent” or “allocate allowance” API.
Load history/retry/ancestry facts within their own ten-second limit before a write's
two-second authority check. Watch only small member, participation, assistant, team/
payer and grant streams. Reads check access once without `authorityFence`.
Check semantic Stop/close/end incrementally as activity, not whole-chat access watches.

Derive descendant ids from silo/root/computer generation/native spawn/child thread;
persist trusted call ids from PR 5, never text equality or caller-supplied headers.
Same-id retries compare principal, subject, full immutable binding and payload.
Changed ancestry/requester/payer/scopes/body returns conflict; duplicate admission
returns the stored task/turn/root/hold, including after NATS dedupe expiry.
Lost replies after computer start, delegation start, token delivery, Stop or terminal
append query original references and append only missing stages. An expired token
can be renewed for the same live binding; renewal is no new start/root/reservation.
Unknown provider/tool outcome never resends. Status not found is not proof of no append.

Build `delegations` as a rebuildable read table plus root indexes in existing budget/
computer summaries. Keep original event ids/positions, parent relationships, terminal
facts, saved output and unfinished cleanup references. Commit projection/checkpoint
together. Read models do not allocate or stop work. Root money comes from the actor
fold; expose its observed budget position separately from outcome projection position.
Statuses: queued/admitting, running, waiting, stopping, completed, failed, cancelled.
“Partial result” means saved output plus unfinished/failed/cancelled work; “effect
unknown” is independent dispatch evidence; “restricted” is this viewer's access result.
Terminal execution does not imply settled money; late success cannot undo cancellation.

## 5. Screens, APIs and phone layout

Proposed routes reuse session/Origin protection, strict protocol and no-store.
GET `/api/conversations/:id/subagents?rootTurnId&cursor&limit` returns authorised
root cents/payer, outcome rows, safe links, observed positions and `canStop`.
Use default 20/max 50, with no hidden totals; current root cap fits a single page.
GET `/api/conversations/:id/subagents/:delegationId` supplies the full-page saved
thread/outcome. Root-filtered existing `/ws` delivery invalidates safe summaries;
fetch under current access. Never expose raw private reports or approval arguments.
Stop all reuses message POST `{id, stopTurnId: rootTurnId}` and existing
`/api/conversations/:id/changes/:commandId` for receipt. Root GET confirms cleanup.
Do not let the client select descendants or infer a new root from a vanished row.

| Frame | Server facts and action |
| --- | --- |
| THR-60 empty/running | Root GET supplies one allowance, settled/held/remaining and verified task hierarchy. Empty means no admitted descendants after a successful read, not load failure. Stop all appears only for the bound requester and active root. Links open full-page authorised threads. |
| THR-61 end states | Same GET shows recorded completed/failed/cancelled and saved partial output. Dispatched count needs actual call evidence, not allow decisions. Restricted rows have no hidden metadata. |
| THR-62 stopping/stopped/exhausted | Stop receipt is intent saved; show stopping until actual termination evidence. Show confirmed stopped count only for visible tasks. Retain reserved cents/unknown effects. Root/ceiling refusal uses the same cascade reason; Check status reads the original command/root without resending. |

At 390 px the panel is a full-screen overlay with Back, trapped focus initially
on its title and focus return to its opener. Use the existing 56 px bar, 44 px
targets and full-width Stop all. Wrap task names, reasons, amounts and payer; stack
labelled money pairs without horizontal scroll. Back closes the panel, never Stop.
Keep glyphs plus words and separate reserved/settled texture; announce finite status
transitions politely, never every token. Reduced motion freezes loops/entrances.
Fix THR-62's phone card overlap/clipping; uncertain-effect text must remain readable
above its action and the real safe-area composer. Human parents have no agent Stop
composer control. Denial purges protected data and ignores late responses; service
failure stays retryable. Omit illustrative Files/Activity counts without safe evidence.

## 6. Ordered PRs and failing-first tests

Land sequentially, server before screens; at most two dependent PRs open. The requested
split overrides the usual whole-feature PR rule. Each ceiling includes tests/docs and
release notes, with no compressed code. Reuse #90 PRs 4–5 once; if not landed, deliver
their two 550-line outcomes there, not duplicate them in #93. Their tests cover root
240/110/650, competing ceilings, frozen retries, old permits and late settlement.

| Order / ceiling | Complete outcome | Write failing behaviour tests first |
| --- | --- | --- |
| 1 / 500 | Modern/legacy delegation contracts, computer-root indexes and replayable outcomes; no native enablement. | Legacy replay grants no authority; forged/mixed payloads refuse; rebuild preserves hierarchy/cents and spawns nothing. |
| 2 / 550 | Internal verified descendant admission, server limits, narrow scopes and signed decision validation. | Competing replicas cannot exceed limits; cycles/foreign parent/generation/requester/payer/scope refuse before token/hold; inherited revoke with stale FGA denies. |
| 3 / 550 | Native bridge evidence, exact thread grants/proxy routing and saved task output, disabled unless server support is advertised. | Recording Codex child first-call race; no parent-token fallback; spawn completion differs from task completion; shared/private context and report isolation; malformed report does not break later acknowledgements. |
| 4 / 500 | Durable stop/exhaustion/revocation checks at every call/renewal and old-permit dispatch gate, using PR 5. | Stop races actor queue/audit/permit hand-off/approval/zero-cost tool; no post-prohibition dispatch; unsent release versus unknown hold; unaffected root continues. |
| 5 / 550 | Root-specific interrupt, proxy abort, grant/wait cancellation and isolated-process cleanup. | Preparing/active/grandchild Stop; lost interrupt reply and deadline kill; unrelated session survives; terminal proof controls slot/suspend release; parent/child chats remain open independently. |
| 6 / 500 | Restart/loss/terminal reconciliation and qualified native enablement through existing capability handshake. | Kill at start/start-event/token/dispatch/terminal boundaries; restart preserves one root/hold; root completion drains children; late duplicate usage settles once; disabled-effect replay produces zero calls. |
| 7 / 400 | Authorised root/task status APIs, full-page data route and original-command receipts. | Root-reader/requester matrix; no parent-only/private/restricted metadata; projection lag/lost Stop reply; removal during blocked read and late response; long-chat activity leaves readers open. |
| 8 / 500 | Subagents money/tree/end-state panel and full-page navigation, THR-60/61. | Desktop/390 empty/loading/error/running/long names/restricted/partial; correct cents; keyboard/Back/focus; thread link rechecks access and never starts work. |
| 9 / 400 | Stop all, stopping/exhaustion/unknown presentation and complete journey, THR-62. | Lost reply checks same id; duplicate clicks append once; measured stopping versus ended/held; phone clipping/reduced motion; late response purge; routine-shaped root Stop contract fixture. |

Estimated new ceiling 4,450 lines, plus 1,100 only if #90's actor prerequisites are
still missing. This revises #93's 1,250–1,500 estimate to cover the actual admission,
dispatch, isolation and recovery gaps. Measure each diff; preserve complete outcomes.
Use real disposable NATS/PostgreSQL/OpenFGA/gateway fixtures and recording upstreams;
the pinned offline Codex probe must prove early ancestry, child routing and isolated
kill before enablement. Tests inspect durable dispatch counts, rights and cents.
Implementation updates people/robot READMEs and diagrams, catalogue/wire contracts
and one branch-named release note. Gates: lint/typecheck/test/check:events and relevant
web build under `nice -n 10`, independent review and green CI. Do not overlap a root
suite with live-view qualification. Fresh-install desktop/390 journeys include native
two-level races, Stop during dispatch, kill/recovery, revocation and late settlement.
Source ready and capability done remain separate. All implementation evidence here: NOT RUN.

## 7. Open questions and recommended defaults

- Limits: two levels, four direct children, eight lifetime admissions, four active
  descendants. Enforce in computer-stream admission, not configurable UI here.
- Child money split: per-call holds, no fixed child allowances or fairness scheduler.
  A refusal stops the root. Filling capacity with valid holds alone does not invalidate
  those holds; a subsequent over-cap attempt or a lowered binding ceiling triggers Stop.
- Root ends before children: stop the unfinished tail and wait for verified cleanup
  before dequeuing a follow-up. No background descendants or silent new roots.
- Native protocol readiness: require pinned-version proof of ancestry before a first
  call, including child calls that race spawn completion. Otherwise keep native
  admission disabled and report qualification NOT RUN/FAIL, not a header-based fallback.
- Full-page threads: read-only native task routes under their root conversation;
  independent summoned conversations keep #91's routes and lifecycle. No extra audience.
- Allowance setting: reuse #90's 1,000-cent default/review. D13 allows a later admin
  setting; reuse an existing event-backed setting if delivered, without a new editor here.
- Conflict holds: retain main's conservative settlement-plus-full-hold rule. Never
  promise automatic release for conflicting evidence; use the existing Spending evidence
  process and report an unresolved conflict as held. Stop supplies no refund evidence.
- Cancellation time: two seconds to initiate connected cancellation, ten seconds before
  isolated-process termination; measure them. Offline/upstream completion stays uncertain.
- Routines: #106 uses stable occurrence id to call the same root admission operation,
  carrying owner, assistant, company connection/profile, payer and frozen revisions.
  Each due occurrence gets one root; duplicate due delivery reuses it. #107 pause/retire,
  owner/connection loss and invalidated Ask use this stop operation. Schedule edits and
  reassignment affect future roots only; old approval/credential bindings never change.
  Retain no-overlap/no-backfill, owner-only Ask, and Run now as a new occurrence. Safe
  retry resumes only proven undispatched stages; status reads and replay never fire work.
