# Recoverable child chats, serial turns and reviewed publication

Design for GitHub issues #90, #91 and #92, 10 October 2026.
Read-only source inspection on `work/p4-8-design`; HEAD, local `origin/main` and
GitHub main were `6381633091ce1c7cd80b6acb11215f68a40f43a7`.
Only this note was written. Tests, builds, stacks and live qualification: NOT RUN.
No model calls; network use was limited to GitHub reads.

## Sources, prerequisites and actual baseline

Read issues #90–#93 and #90–#92 Design/comments; accepted fleet notes `p4-5-design.md`
and `p4-6-design.md`; AGENTS.md, plan/standards, Phase 4 spec/decisions and money rules.
Read `05-thr/README.md` and both frame sizes for THR-12, 20–23, 30–32, 40–45,
40-RM, 50–53 and 60–62 under `/home/jente/dev/design-handoffs/v2/`.
Inspected server chat/turn/participation/private-context/bridge/realtime, computer
runner/input/private launch, event/projection/OpenFGA, model authority/decision,
budget actor/state and file code, plus relevant robot READMEs. Some docs are older
than main; frames are design references, not implementation proof.

Merged group chats have explicit people, a 97-person command cap, small
`participation-<id>` streams and immediate event-backed removal. Agent sessions
still default to requester-private team turns; creation and payer checks bind the
creator, so merely adding participants cannot produce a safe shared child.
The runner suppresses duplicate ids and serialises locally; the bridge chooses the
earliest unfinished input. Extend server-wide admission and shared-only evidence.
The actor has per-call holds/late settlement, but no root allowance/stable call retry.
Delegation tokens still require singleton requester ancestry.

Require #87, #88 lifecycle/closed cleanup and #89 requester/thread behaviour before
child controls. Supply root accounting for #93; native delegation remains its work.
The file API has session uploads but no final registration/audience share and refuses
group reads. That missing contract is a prerequisite for #92's complete asset journey.

## 1. Meaning and permissions

An active member may summon one permitted group assistant from their own visible
`message.posted` in an open human `group`. Check author/principal, exact silo/parent/
message and current parent post rights. Refuse other authors, publications, hidden
pre-join messages, direct chats and guessed ids. Literal `@agent` stays text;
autocomplete selection stays local until labelled Start after review requests work.
Denial preserves the saved source.

Review source, assistant, audience, fixed payer and allowance upper bound. Offer Only
me or an explicit parent-participant subset including requester; each must read the
source now. Freeze people/parent join ids, without later joins. Bind the assistant's
recorded paying group; parent association/personal defaults grant no payer or rights.
One child per source: changed assistant/audience/payer requires a new human source.

Keep `mode: agent_session` immutable and add a strict `contextKind: shared_child`
creation alternative. Only the server can create that alternative from a verified
parent intent. Only me still uses shared-only execution; it is not a route into
the creator's private member session. Private sessions retain their current guards.

| Operation | Current authority required |
| --- | --- |
| Summon/first activation | Parent source visibility and post; recorded initial child participation once created; assistant `acts_for`, owner/payer-group membership and applicable grants; open parent and child. |
| Read/follow | Active member, recorded effective child participation and OpenFGA `conversation#read`; no assistant-spend permission required just to read retained shared history. |
| Follow-up | Child read/post, open child, sender's current assistant/payer/model/tool rights. Sender becomes this turn's requester, including its approvals and profiles. |
| Invite/remove/close child | Recorded creator with current child read and `manage_participants`; non-creators may leave themselves. No administrator bypass. |
| Review/publish | Current child read, visible selected result and immediate-parent post/source visibility; parent open. Reading a child alone never permits publication. |
| Stop | Current child access plus the existing turn's bound requester; no spending grant needed. System revocation/close cleanup is separate. |

For inherited rights, require the person's and creator's original parent joins still
active. THR-45 says creator departure ends inheritance for everyone; show that rule.
Removal/re-addition does not revive either recorded join. Explicit child-only joins
are independent, survive loss of inherited rights and give shared history from child
creation. Invite only active same-silo members, after review of that history release.
They gain no parent, file, memory, profile, desktop, approval or assistant grant.

Use OpenFGA explicit person participant/creator/silo tuples and applied-event receipts.
Check recorded parent dependencies too; lagging removal tuples cannot allow access.
Record join kind/source references for replay; no `team#member` child audience tuples.
Keep the audience within 97, including creator, unless an independently reviewed
atomic tuple-write change lowers the usable cap. Ordinary group late-history policy
stays latest-join onwards; child shared-history position is separate from authority join.

Parent and child keep independent history, unread, archive and monotonic close.
Parent close blocks summon, unadmitted first activation and publish; an already
admitted authorised child can continue. Child close stops its own work and inputs;
it never closes the parent. Recommend allowing review of an already saved result
from a closed child into an open parent. Stop affects an execution root and later #93 descendants, without closing any conversation. Archive never affects execution.

## 2. Shared context, access timing and revocation

Encrypt the reviewed source as the first child input; never copy parent history.
A later child invite releases that shared input, not parent metadata/other messages.
Rebuild completed shared exchanges only, within the existing 24 KiB cap. Omit
unfinished/lost request text, deltas, reasoning, tool results, approvals and private
files. Select records by their server-recorded content class.

Run each sender in a fresh requester-bound restricted process/thread. Record and
sign `sharingClass: shared_only` separately from `executionMode: restricted`.
Never resume another sender's private thread or use `privateContext` as a shared
history reader. Exclude personal memory, preferences, profiles' private content and
shared persistent workspace/browser state. A label or prompt cannot establish this.
Initially offer no memory or local file/shell/browser tools. Add shared resource
tools only through #89's proven scope-limited path; requester and assistant grants
must both hold. Group memory needs separate grants and shared-execution proof.
Do not enable disabled memory admission as part of these issues.

Restrict shared reports to that admitted execution. Keep private reports/results
on their existing requester-private conversations; none enters child feed, status,
notifications or parent summaries. Show another sender's approval only as safe
action/requester/expiry metadata; encrypted arguments and decisions remain bound
to the requester. Never expose a personal connection/profile in shared metadata.

Reads check access once per request/page, without `authorityFence`. Load history,
source/retry facts and cold summaries with a separate ten-second deadline before a
write/start's two-second access check. Watch only the operation's
small member, parent/child participation, creator member, assistant, team/payer and
grant streams. Point-read immutable creation and saved references; never include
either whole conversation stream in an authority check or reading/view subscription.
Use conversation positions for conditional append and incremental semantic close
checks only. Turn/file activity cannot revoke a reader or end a viewer.

Every HTTP/socket/file/approval/status reader uses effective child access. Inherited
subscriptions also watch parent participation and creator membership. Poll independently
of blocked content reads; revoke within two seconds of removal append, before IAM
deletion. Purge transcript, title, origin, files, counts, drafts, pending actions and
cached list rows; invalidate request generations and discard late HTTP/socket replies.
Foreign/missing/denied ids share generic unavailable presentation. Unapplied active
joins return 425 applying; outages remain 503 retryable, never false success.
Never send full intent/creation payloads through today's passthrough feed to a
parent-only reader. Return a strict authorised display contract before decryption.

## 3. Events, commands, streams and recovery

Proposed additions below must land with strict schemas, registry stream ownership,
catalogue trigger tables and wire contracts together. Reuse existing reports;
chat children are not `delegation.started`, which belongs to native tasks in #93.

| Event / stream | Recorded fact and reaction |
| --- | --- |
| Existing `message.posted` / parent conversation | Save human source once with its original command id. Human send itself dispatches nothing. |
| New `conversation.child_requested` / parent conversation | Source id/position, request id, child id, first-input id, creator, assistant, payer, reviewed allowance upper bound, audience and original parent joins. Reconcile creation/input/activation. No copied private text. |
| Extended `conversation.created` / child conversation | Shared-child alternative binds exact intent, immediate parent/source, assistant/payer, creator and initial joins. Initialise child participation and IAM once. Legacy/private alternatives remain distinct. |
| Existing `message.posted` / child conversation | Deterministic first input, attributed to original requester and bound to intent; shared-only content. It remains ineligible for bridge delivery until activation exists. |
| New `conversation.child_activated` / child conversation | Bind intent and first input after prerequisites and fresh rights checks. Make that input eligible for ordinary bridge preparation; do not mint a token in this command. |
| New `conversation.child_start_failed` / parent conversation | Request/attempt id, failed stage and safe reason; distinguish proven pre-dispatch failure from uncertainty. System may record outcome after parent close, without reopening it. |
| New `conversation.child_retry_requested` / parent conversation | Requester asks to resume the same proven pre-dispatch failed request, with expected failure event and stable retry id. Never reset child/input/root or repeat executed work. |
| Extended `participant.added/removed` / child participation | Explicit child-only join/removal with authorising creator and review position. Child-specific history rule; no parent/resource tuple. |
| Existing `computer.turn_started/closed` / assistant computer | Bind requester/thread/generation, shared-only class and root id; conditional start refuses any other unfinished foreground turn in this child. |
| Existing agent turn/output/Stop and approval events | Retain child-only output, serial outcomes and requester-bound approval streams. Computer/agent terminal records reconcile independently. |
| New `budget.root_allowance_set` / silo budget | Actor records immutable root/requester/turn/child/assistant/computer generation/payer and admitted `allowanceCents`; no second reservation or charge. |
| New `budget.root_stopped` / silo budget | Actor records root dispatch prohibition, reason and source Stop/terminal/revocation/exhaustion evidence. Settlement stays possible. |
| Extended `budget.reserved/settled`, existing effect events | Reservation names root and exact call; existing effect evidence settles/releases that same reservation once. |
| New `conversation.child_result_published` / immediate parent conversation | One immutable credited entry: publication id, publisher, child/result/turn references, final/interim kind, review digest, parent-encrypted exact text and vetted asset references. No execution reaction. |

Each command conditionally appends once to one stream. Sequence commands through
existing HTTP/handler runtime; no SQL business writes or cross-stream transaction.
Derive child/stage ids from verified silo/parent/source/request, using hashes with
different operation prefixes. Save client source/request ids before sending. Match
principal, subject, type and full payload on retries; changed reuse returns 409.
NATS's short duplicate window is insufficient. Derive child identity from silo/parent/
source, independent of client request id. Check existing intent by source before the
parent append; concurrent intents conflict and reload, returning the original child.

| Crash/lost reply after | Recovery using original references |
| --- | --- |
| Source append | Reconcile existing message command; then review/request that exact source. No automatic summon from text. |
| Parent intent | Return stored intent/child id; resume only missing stages with the frozen audience/payer. |
| Child creation | Verify child against intent, wait for IAM receipt, append only missing first input. |
| First input | Verify saved text/requester; keep bridge blocked until activation. |
| Activation/root allocation/start | Query stored child/computer/budget records; reuse root and turn. First token still needs current authority and initial activation checks. |
| Model dispatch or terminal report | Reconcile reports/effects and missing computer/agent closure; never infer no execution from silence or run the first input again. |

Use existing durable jobs keyed by request and event evidence, with bounded retries;
restart scans indexed unfinished intents then verifies their log records. Jobs are
receipts, not truth. Denied/closed requests remain recorded and visible where allowed.
Pre-dispatch safe failures can resume stages; an admitted restricted process lost in
a crash fails under existing private-turn rules. Its child/history survives. A new
explicit follow-up can ask for new work; it is not recovery of the lost execution.
Activation and first computer start recheck parent/child rights, grants and close.
Cross-stream close/removal can commit just after admission; document admission-time
ordering and refuse subsequent initial grants when an intervening close is observed.
Do not claim atomic parent close plus child start. Never broaden a frozen audience
to replace someone who lost access; require another source/review instead.

## 4. Money and serial work

Human parents have no allowance/reservation. Each admitted child foreground turn
is a root. The existing actor records its allowance before the first token: at most
1,000 cents and remaining global daily/monthly, payer-group and assistant ceilings.
Review states an upper bound; refuse/re-review if admission cannot honour it or fit
the conservative first-call bound. Allocation is not spend or guaranteed global
capacity. Actual calls reserve capacity.

All model calls and later same-computer native descendants use that root, original
requester and immutable payer. Each `budget.reserved` is the call's sole hold;
root/global/group/assistant totals are views of it, not additional charges.
Require `rootSettledCents + rootHeldCents + nextCallBoundCents <= allowanceCents`
and every applicable ceiling in the actor's same serial conditional append path.
Unknown/conflicting calls retain the existing full hold, conservatively alongside
any recorded settlement; known final settlement releases unused capacity.
For example, a 1,000-cent root with 240 settled and 110 held has 650 remaining;
a 651-cent call refuses even when the silo still has money.

Bind call retry identity to the trusted proxy/request and body digest, not text
equality or a browser-selected header. Persist its reservation/decision ids; duplicate
admission returns that hold and altered reuse conflicts. Today's random reservation
and decision ids are insufficient for this new guarantee. An uncertain provider
reply must not trigger a second send with the old permit. If trusted dispatch/retry
identity cannot be demonstrated, fail the uncertain call and hold its money.
Root retries, reconnect, period rollover and actor leadership change never enlarge
the root. Settlement uses original provider/model/tariff/payer and remains idempotent.

Source/intent/create/input/activation/read/invite/review/publish reserve zero cents.
Release proven undispatched calls via existing `budget.settled` not-dispatched path;
audit/grant failure before returning a permit is such proof. Dispatched/uncertain
calls remain held through timeout/loss/operator evidence resolution. Stop, close,
revocation or failure never means refund. Reconciliation must include stranded
allocation/start/report boundaries and disabled old reservations, not just open chats.

Queue follow-ups in message-event order, one preparing/running/waiting turn at a time.
Recheck sender rights on dequeue and confirm predecessor termination before start.
A new follow-up gets a new admitted allowance; input retries retain theirs. Approvals
keep the slot. Private member sessions remain independent within computer capacity.
Stop, terminal end, revocation and root/ceiling exhaustion prohibit new dispatch,
including old reservations, before releasing tokens. Record `root_stopped` separately
and reconcile missing writes; gateway checks original Stop/close/access evidence too
so reaction lag cannot authorise a call. #93 inherits these checks for descendants,
verifies native ancestry/same computer/narrowed scopes and adds cancellation outcomes;
no claimed ancestry, new child root or second tree ledger can bypass this actor.

## 5. Projections, summaries and reviewed publication

Extend rebuildable conversation metadata/intervals with child binding and join kind;
add indexed child-request/stage and per-turn status references. Fold status in named
TypeScript functions from events, with permanent close separate from turn outcome.
Use computer/approval/effect references for actual start, waiting and uncertain work.
Commit projection effects, event ids and checkpoints together. Rebuild tables/generation,
actor totals and OpenFGA through existing offline paths, without external effects.
Normal restart resumes intent reactions only after verifying stored stage ids.

Before publication the parent has its human source and a finite child status card.
For current parent-plus-child readers show source-derived title, state and observed
times only by default; omit progress prose, result previews and file/tool counts.
THR-30's illustrative prose/counts are child content, so keep them in the child.
Parent-only readers receive only “Agent thread restricted”, without hidden child id,
question/title/result/filename/count/state/attempt metadata or an actionable link.
Initial intent fields are filtered the same way on HTTP, replay and sockets.

States: failed-start from recorded stage failure; queued from intent/pending input;
starting from saved creation/
activated input without admitted start; working from admitted start; waiting from a
live bound approval with real expiry; retrying from recorded safe retry/stage evidence;
completed from terminal completion with saved output; completed-after-retry only with
recorded earlier safe failure; failed/cancelled from terminal reason/confirmed Stop;
closed from permanent conversation close; restricted from denied child read.
Show stopping while termination remains unconfirmed. Output lost is failed/incomplete
with explicit unavailable output, never a usable final draft. Do not invent attempts,
durations, external-effect counts or “nothing ran” without dispatch evidence.

Completion offers a draft from saved shared output, without a parent append. Interim
review selects saved shared text or a human-authored update, never live tokens.
Show exact sanitised text, parent/current audience, source, publisher, kind and assets.
Keep the existing 32,000-character limit, escaped rendering and validated references;
exclude private memory, raw HTML/history/tool output and approval arguments.

Return a short-lived server-signed review binding publisher/silo/parent/child,
source-result revision, exact text/asset digest and parent access position. This is
ephemeral review evidence, not a permission or business-state database row. Changed
text/assets/result/audience needs a new review; token validity cannot replace current
child read/parent post/file authority. Unrelated token/file activity is not a stale
review. Publication appends once on the parent content stream, racing parent close
by conditional expectation. Retry checks the saved publication before token expiry/
staleness rules, while requiring current read rights; it never posts twice.

The immutable entry says “from Agent thread” and credits its human publisher.
Parent readers see published text without child access; the link still checks rights.
Keep unshared title/history hidden. Later publications append new entries. Publish
never wakes a computer or starts a turn, even with a later agent-session parent.

Assets must reference immutable, scanned, registered final objects and already be
readable by every reviewed parent recipient under current file-specific rights.
Recheck on publication and download; never confer access through a link or filename.
Refuse inaccessible assets without names or hidden counts. Any necessary share is
a separate explicit reviewed release, with its own event/receipt, before re-review;
that deliberate file release is not automatic leakage from completion. Until the
missing final/share contract lands, text publication works and assets fail closed. #92 cannot be called fully done or its file journey PASS on that partial capability.

## 6. Screens and API mapping, including phone layout

Reuse session/Origin checks, strict parsing, no-store HTTP and version-1 `/ws`.
The child uses an immutable-id full-page route, never a panel transcript.
All additions below are proposed, including display fields on existing routes.

| Frames | Contract and navigation |
| --- | --- |
| THR-12/23 | Existing message POST saves plain mentions. Reuse permitted assistant discovery; no eligible assistant means no suggestions/Ask control. Selection never calls a child endpoint until explicit review. |
| THR-20 | New POST `/api/conversations/:parent/child-review` validates source/assistant/audience and returns signed reviewed bounds. Start: POST `/api/conversations/:parent/children` with stable id, sourceMessageId and review; server derives child/input ids. Save source through ordinary separate message POST first. Cancel appends nothing. |
| THR-21/22 | GET `/api/conversations/:parent/children/:requestId` returns authorised stage/receipt and summary. Safe retry POST `/children/:requestId/retry` carries stable id and expected failure reference. Unknown outcome uses GET only. One route/child for all retries. |
| THR-30–32 | Bounded GET `/api/conversations/:parent/children?after&limit` returns viewer-specific cards (default 20/max 50). Parent socket invalidates by visible source-message id, without hidden child ids; re-read cards with current rights. No child tokens/logs on parent topic. |
| THR-40/41/40-RM | Existing child messages GET and `/ws`; new GET `/api/conversations/:child/origin` checks parent source read separately. Breadcrumb/Back use parent id/source anchor only when allowed. Completion crease uses terminal time; Review and publish waits for #92. Stop reuses message POST with stopTurnId. |
| THR-42/43 | Existing child message POST queues serial requester-bound input; existing approval reads/decision API retains bound requester. Composer identifies current sender. No action buttons for another person's approval. |
| THR-44/45 | Extend existing child participants GET/POST with explicit invitation review and expected access position; same-id change GET confirms join. Child-only origin is restricted, without parent title/id/link. Invitation review states all shared history is released. |
| THR-50/51 | New POST `/api/conversations/:child/publication-review` takes selected saved result, final/interim kind, exact text and asset refs; returns sanitised exact review and signed binding. No event or model call. |
| THR-52/53 | New POST `/api/conversations/:child/publications` carries stable publication id and reviewed binding. Server chooses immutable immediate parent. Existing parent change GET confirms that id; 409 re-review, 403 unavailable, 503/transport loss Check status. No target-parent picker. |

At 390 px use 56 px header, 44 px menu/targets, wrapped names/breadcrumbs and no
horizontal scroll. Source/status cards and Open thread fill available width.
Origin collapses by default; keyboard-accessible Show origin expands only authorised
content. Keep parent source scroll/focus separately from child delivery/read positions;
Back restores it only after parent access succeeds, otherwise show unavailable.
Reviews/invitations are full-screen overlays with visible Back/Cancel, trapped focus
starting on title, full-width primary action and return focus. Fix clipped secondary
buttons in the reference rather than copying them. Dock composer above real keyboard/
safe area; no drawn keyboard or unsupported upload/microphone/computer controls.
Enter sends text, Shift+Enter adds a line; Start/Publish/approval need labelled actions.
Use glyph plus words, linked errors and polite announcements for finite transitions.
Reduced motion freezes ring/Folding/Flutter/caret and renders completion crease fully.

## 7. Ordered PR split and failing-first evidence

Land sequentially, server before screens, with at most two dependent PRs open.
The requested split overrides the usual whole-feature rule. Count tests/docs in each
ceiling; preserve clarity. Internal prerequisites can land without public commands.
Expose only usable protected endpoints; close each issue after its complete journey.

| Order / issue / ceiling | Independently landable outcome | First failing behaviour tests |
| --- | --- | --- |
| 1 / #90 / 550 | Shared-child creation/join event contract, projection/rebuild and IAM support; no emitter. | Private legacy parsing unchanged; malformed origin/mixed modes refuse; replay child joins/removals identically; old IAM creation cannot restore removed people. |
| 2 / #90 / 550 | Effective inherited child access across HTTP/socket/approval/file/status and strict display filtering, before any child creation API. | Parent removal with stale FGA denies; creator departure denies inherited audience; explicit joins survive; 100,000-message activity preserves readers; blocked delivery revokes within 2 s. |
| 3 / #90 / 550 | Server-recorded shared-only restricted binding and context delivery on existing runner; no summons yet. Reuse #89, keep tools absent. | Changing sender never loads private context; forged class/report denied; first source only; restart never repeats admitted restricted work; zero private text in shared reports. |
| 4 / #90 / 550 | Root allowance/stopped actor events, replay and per-call root totals; no child dispatcher yet. | Worked 240/110/650 cents example; competing holds cap root/global/group/assistant together; payer/allowance retry immutable; rollover/restart retains holds. |
| 5 / #90 / 550 | Trusted call retry binding and root checks at grant/dispatch, preserving settlement and existing non-root calls. | Lost admission reply returns one reservation; altered call conflicts; unknown dispatch never resends; Stop/exhaustion blocks old permits; late duplicated usage settles once. |
| 6 / #90 / 600 | Internal own-source review/intent and separate create/first-input commands, with durable receipts; no public summon emitter yet. | Other author/pre-join/direct/foreign source refuse; plain mention has zero execution; lost source/intent/create/input replies keep one of each; changed audience/payer conflicts. |
| 7 / #90 / 600 | Activation/retry/reconciliation through existing jobs/bridge; first admission/root allocation and public summon/stage APIs. Public follow-ups wait for PR 8. | Inject crash at every stage including root/start; expired/revoked/closed activation denies; busy capacity remains queued; retry returns same ids and no duplicate dispatch. |
| 8 / #91 / 550 | Server serial follow-up, safe completed context, requester approvals and fresh roots. | Concurrent senders start in event order across reconnect/workers; waiting blocks next start; Grace cannot decide Alex's approval; new terminal follow-up gets one new root. |
| 9 / #91 / 550 | Creator-managed explicit late invitation, all shared history, restricted origin and observed finite summary APIs. | Child-only invite exposes no parent/resource rights; removed/re-added parent never revives inheritance; lost invite reply saves once; no guessed attempts/counts/result leak. |
| 10 / #92 / 450 | Final-asset eligibility integration after the separate final/share file prerequisite; read-only references, no group upload/execution. | Private/inaccessible/nonfinal/path-only asset refuses without filename; changed audience/file grant invalidates review; explicit share does not imply child/parent grant. |
| 11 / #92 / 600 | Review binding, one parent publication event and authorised receipt/status; text works independently of asset availability. | No append on completion/review/Cancel; stale/changed review and child-only reader deny; wrong ancestor/foreign id denies; close race; lost reply creates one credited immutable entry and no agent turn. |
| 12 / #90 / 550 | Composer selection/own-message action, summon review, queued/failed/unknown summary and basic full-page child route. | THR-12/20–23 desktop/390; only permitted suggestions; Cancel saves no intent; unknown checks original id; no second source/child after refresh. |
| 13 / #91 / 550 | Full summary vocabulary, serial composer, origin/breadcrumb/Back and completion crease. | THR-30–44/40-RM both widths; long breadcrumb/source focus restoration; independent unread/close; no private context/other-requester approval actions. |
| 14 / #91 / 450 | Invitation/revocation UI and complete late-response purge. | THR-32/44/45 and unavailable state: all shared history after explicit join; no parent link; stale/unknown invite; late HTTP/socket/status cannot repopulate purged data. |
| 15 / #92 / 500 | Exact final/interim review, credited parent entry and publication problem states. | THR-50–53 both widths; focus/Escape/Cancel; payload edits require review; denied asset unnamed; unknown outcome checks same publication; restricted child link keeps published text readable. |

Ceilings total 8,150 lines, excluding the file prerequisite. Reuse #89/#93 work to
reduce actual diffs; the old total omits access/isolation/root gaps. Keep all criteria.
PR 11 can land text publication before 10; dependent screens still follow their server.
Test one public behaviour red then implement it green, repeating within each PR.
Use existing HTTP/WebSocket, actor and event/replay interfaces, real disposable
NATS/PostgreSQL/OpenFGA/gateway fixtures and recording upstreams; assert durable
results, authorisation, dispatch counts and cents. Stubs cannot prove live isolation.
Update people/robot READMEs/diagram, event/API contracts and branch-named release note.
Require lint/typecheck/test/check:events and web build under `nice -n 10`, independent
review and green CI; never overlap a root suite with live-view qualification.
Fresh-install desktop/390 journeys cover crashes, two senders, child-only invitation,
revocation, independent close, publish and late settlement. Source ready is not live done.

## 8. Open questions with recommended defaults

- Child uniqueness? One per source across assistant choices; use another source for
  another child. Creator departure? End inheritance for all; explicit child-only rights
  survive. Re-add never restores inheritance and there is no automatic creator transfer.
- Who manages/closes/stops? Authorised creator manages/closes; requester stops their
  root. System cleans up revoked work; admin rights grant no bypass.
- Shared tools/memory? Start with fresh restricted shared-only turns and no tools;
  require #89's enforced shared-context path before expanding capabilities. Private
  work stays in private sessions and is not silently imported through publish.
- Allowance? Default 1,000-cent upper bound and remaining ceilings; re-review a lower
  amount. No configuration UI here. #93 shares this actor and recorded allowance.
- Retry versus new work? Resume only proven undispatched stages. Lost admitted
  restricted execution fails; explicit follow-up is new work/root, with old holds kept.
- Cross-stream close races? Use admission-time ordering and recheck before first
  grant. Strict atomic parent-close/child-start needs a separate event-store decision;
  never solve it by watching a whole conversation as access.
- Closed child publication? Allow saved authorised results into its open immediate
  parent. Pre-publish summaries? State/timestamps only; progress/counts stay in child.
- Final assets/share gap? Land a separate final-object and explicit audience-share
  contract first, reusing scanned object storage and event-backed grants. Until then
  reject assets and label the file journey PARTIAL/NOT RUN; hide a nonfunctional Share
  action. A separate reviewed share intentionally releases the file; completion does not.
- Drafts/edits? Local signed review, no saved-draft event. Publish immutable entries;
  another review makes a new command, without editing or automatically republishing.

Implementation, tests, gates, image isolation and fresh-install journeys: NOT RUN.
