# Resume, archive and close conversations independently

Design for [#88](https://github.com/elewa-git/opencrane-new/issues/88), 10 October 2026.
Design only. Product code, tests, builds, stacks and live journeys: NOT RUN.
Base: `work/p4-6-design`; HEAD, local `origin/main` and GitHub `main` all
`03630f1b983d3ae27c8060af215f3f88be474aa8` when read. The worktree was clean.

## Sources and existing behaviour

Read #88's body, Design and comments, [#90](https://github.com/elewa-git/opencrane-new/issues/90)
and [#96](https://github.com/elewa-git/opencrane-new/issues/96), including their comments.
Read `<home>/.fleet/reviews/p4-5-design.md`, `AGENTS.md`, relevant `plan.md` rules,
`docs/process/standards.md`, Phase 4 spec/decisions/tickets and group-chat contract.
Read the local `05-thr/README.md` and both sizes of THR-01–04 and THR-14–16 under
`<home>/dev/design-handoffs/v2/`. The frames describe intended behaviour.

Code inspected: server chat commands/access/participation/reads/routes/realtime,
summary, bridge/poll/dispatch, private session/context and turn/report commands;
conversation/computer projections; OpenFGA model and handler routing; computer
turn runner, thread loads and private process; ops idle/suspend; model authority,
approvals, budget actor/reconciliation; file access, view access/leases and web state.
Relevant package robot READMEs and the event catalogue were also consulted.

Creation and content use `conversation-<id>`; access changes use `participation-<id>`.
The participation reader verifies creation, legacy access references, current join,
membership and OpenFGA receipts. Latest join bounds ordinary group history.
The list is currently unbounded and creation-ordered. Its title query is indexed,
but status can stop saying closed when a later terminal report arrives.
The projection already keeps a permanent closed flag and participant intervals.
The web archive flag is local. There is no public close command in `chatInput`.

Closing currently makes `listOpenConversations` omit the chat, and
`processConversation` returns before recovery/Stop. Ops tracks every queued message
as open until a terminal agent event; close alone leaves it there. `readChatFacts.closed`
means a particular turn ended, not that its conversation closed. These are concrete
gaps to fix before exposing close. Files currently deny GET on a closed session;
live desktop access already checks close. Some README/catalogue text is older than
merged group and participation code; update touched contracts from actual behaviour.

## 1. Meaning, ownership and access

Keep three independent facts: conversation lifecycle `open | closed`, the current
participant's `archived` choice, and that participant's read position. A completed,
failed or stopped turn does not close its conversation. Archive does not leave it.
Resume means open the same immutable-id route and catch up with authorised history.
It creates no resume event, message, turn, reservation, computer or memory write.

| Kind | Resume and archive/unarchive | Permanent close |
| --- | --- | --- |
| Direct human chat | Either current participant reads and changes only their own list/read position. | Recommend either current participant may close this chat for both people. |
| Human group | Each current participant independently reads and archives. | Recommend only the recorded creator, while still a participant, closes for everyone. |
| Personal assistant session | Its current authorised requester reads and archives. | The requester closes that session. Other sessions with the assistant remain open. |
| Shared-assistant member session/thread | Only its recorded requester, still authorised for the assistant's group, reads and archives. Group membership does not reveal another member's session. | Its requester closes this private conversation, not the assistant or other members' threads. |
| Private restricted turn | A turn has no separate list, archive or close choice. Resume its containing conversation's transcript. A new message asks for new work. | Close its containing conversation, or use existing requester-only Stop for this turn. Never resume its ephemeral process. |

For every operation derive identity from the verified session. Require current member
events, current participation events and OpenFGA `conversation#read`. For groups,
close also requires `manage_participants`, backed by the recorded creator. Direct
close requires read plus the recorded direct audience; session close requires read
plus `createdBy`. Reuse these relations; no administrative or group-wide bypass.
Shared-assistant reads retain `requirePrivateReader`, owner-group membership and
`acts_for`. Closing, archiving and marking read do not require permission to spend.
New assistant work separately checks payer, assistant and resource grants.

Archive hides a row from Recent and shows it in Archived for that person only.
Opening, new activity and sending do not silently unarchive it. Unarchive is explicit.
Closed chats can be read, archived, unarchived and marked read; they cannot reopen.
Close freezes human input, uploads, screenshots, summons, publication and new turns.
It does not remove participants, erase events, destroy keys or forget memory.
Keep closed chats in their existing list section with a lock and read-only label.

Removal denies all reads, including old history, status, files and saved preferences.
Clear protected browser data and ignore late replies. Re-addition starts a new
ordinary join interval; old read/archive choices do not apply to that new interval.
Initial participants see creation onwards; ordinary late joins see their latest join
onwards. Preserve global join/end positions and event ids through replay/reconnect.

Later #90–#92: parent and child have independent lifecycle, archive and read state.
Closing either never closes the other or changes either audience. A closed parent
prevents new summons, first activation and publish-back; an already active authorised
child may continue. Parent removal still ends inherited child access. Child-only
invitations grant no parent rights. Explicit late shared-child joins see shared child
history from creation, using a history bound distinct from their authority join id.
Private member history/resources are never included. No child machinery ships here.

## 2. Execution, resources and context

| Operation | Running/queued work | Other effects |
| --- | --- | --- |
| Resume/read | Keep existing serial admission per agent session. Never resend an uncertain request. | No wake merely to read; no new grants, spend or context injection. |
| Archive/unarchive/read marker | Leave running turns and the queue alone. | Leave reservations, views, files, computer idle time and memory alone. |
| Close | Reject new work; cancel every queued input and interrupt admitted work for this conversation. | End its desktop views, keep authorised saved history/files, and reconcile execution/spend independently. |

Direct/group messages remain human-only, including literal `@agent`. They produce
zero turn, wake, provider, tool, approval or budget events. Report `not_applicable`.

Treat the committed close event as durable cleanup intent. Reuse the existing bridge
watcher, turn commands and handler runtime, not a second executor. Keep closed agent
sessions with unfinished cleanup eligible for reconciliation; do not rely on an open
list or a live socket retaining them. Find pending work from events and indexed
candidates, then verify it. Every cleanup command still appends once to one stream.

For never-admitted queued messages append deterministic system `agent.turn_failed`
with reason `conversation_closed`, once per input. Preserve the original message.
For preparing/running turns send the existing conversation/turn-bound interrupt,
cancel approvals and refuse grant renewal and subsequent model/MCP calls immediately.
Do not mint a token/context in an acknowledgement for a closed conversation. Treat
a verified delayed start as a normal refused admission; acknowledge its report without
granting execution. It must not poison the shared bridge with permanent 1008 refusal.

Keep a running turn's computer suspend protection until termination is confirmed by
a terminal report, private-process exit, or verified loss/replacement of its computer
generation. Then recover any missing `computer.turn_closed` and terminal agent record
through separate idempotent commands. A Stop-send acknowledgement alone is insufficient.
Show closed immediately, with cleanup still pending where necessary; never claim a
remote effect was undone. Offline cleanup stays retryable and visible, not forgotten.

Reuse `TurnRunner.interrupt` and grant/catalogue release. Close the restricted process
and remove its RAM-backed home through the supervisor's existing exit/kill path.
Memory-free completion currently forgets the load catalogue and revokes the grant;
that is not proof Codex unloaded its persistent thread. For conversation close,
explicitly unsubscribe its loaded thread and confirm disappearance using the existing
bounded `threadLoads` unload logic. Retry uncertain unload without loading it again.
Do not unload, interrupt or restart another member's thread or the whole assistant.

Keep `conversationClosed` separate from a turn's `turnEnded` in command/admission facts;
today's `ChatFacts.closed` must not serve both meanings. Enforce output freezing in
server display reads before the close API lands, then mirror it in the web reducer.
Record verified late bridge reports with their existing digest/sequence checks, including
terminal and lost-output reports. Never break the shared report queue's continuity.
Freeze displayed partial replies at the close position, as Stop already does; late
content does not change the closed transcript, status or unread count. Retain raw
reports as execution evidence. A late completion cannot turn closed into done/open.

Reservations belong to calls, not to archive or a conversation status. Cleanup must
find calls by conversation/turn/permit, retaining their frozen payer/provider binding.
Use the existing single budget actor and settlement reactions. Release only proven
undispatched reservations; settle observed usage once, including usage after close.
Dispatched or uncertain effects remain explicitly held with their original ids and
reconciliation status. Retain timeout, loss and human evidence resolution paths;
never turn absence of a reply or close into a zero-cost refund. Duplicate cleanup,
effects and replay cannot add a second reservation or charge. No blanket budget write.

Normal transcript sockets stay readable after close; close is content, not revocation.
Desktop tickets/control/capture require an open session; end existing conversation
views through their current lease checks and record `view.ended` once. Do not return
the whole workspace's access-changed screen merely because its desktop view ended.
Keep the existing byte-lease and outage bounds; ordinary turn/file activity must not
deny readers or end viewers. Archive never ends a view. Other sessions' views survive.

Recommend allowing reads of already saved session files after close, with exactly the
same current participation, join bound, private-session and file-specific restrictions.
Remove only the closed-state denial from GET; keep writes/capture/delivery admission
closed. This is an explicit change from today's GET behaviour, not a broader file grant.
Human chats gain no file or desktop capability. Revocation still denies filenames/bytes.

One computer remains assigned to each assistant. Once actual turns finish, remove
their queued/open activity entries so normal idle suspend can proceed. Closing or
archiving never directly suspends/retires a computer, wipes its workspace/browser,
or wakes it solely for cleanup if its generation is already known lost/suspended.
List/read-marker events must not count as computer activity. Uncertain thread unload
or process cleanup remains pending with safe ids/reasons; expiry of grants is not
proof the process exited. Keep retrying without repeating its input or external calls.

Issue #96 remains the context boundary: team turns default restricted, at most two private
turns per computer; unfinished private work fails after restart, even if prepared.
Fresh requester-bound threads rebuild only authorised completed exchanges, capped
at 24 KiB; omit interrupted request text, deltas, reasoning, tools, files and approvals.
Memory-free turns receive no earlier private context. Recheck access and close before
delivering rebuilt context. Archive/close neither copies nor deletes memory facts.
Keep memory admission disabled until its existing disk/swap qualification passes;
lifecycle work supplies no new privacy proof or persistent SOUL/prompt/session recovery.

## 3. Events, commands, projections and recovery

Use existing `conversation.closed {conversationId, closedBy}` on `conversation-<id>`.
The server binds `closedBy`; envelope time/id/sequence supply the closing evidence.
Fold the first close permanently; later reports cannot change its identity or time.
Creation/send retries may return their original receipt while read access remains,
but never recreate/reopen, re-add participants, dispatch or restore a composer.

Add only these two preference events, on `chat-state-<memberId>`:

| Event | Strict data; rule |
| --- | --- |
| `conversation.archive_set` | `conversationId`, `memberId`, `joinEventId`, `archived`; set one caller's choice, default false for each new join. |
| `conversation.read_advanced` | `conversationId`, `memberId`, `joinEventId`, `throughPosition`, `throughEventId`; monotonically advance within that join's authorised history. |

Validate exact subject, silo, principal and data ids. Preference events contain no
text, filenames, credentials or other participants' state. They never enter the shared
conversation feed or OpenFGA. Extend stream ownership, schemas, registry, catalogue
and protocol together. Existing legacy participation subjects remain replayable.

Preference commands load incremental event summaries/retry positions before opening
the short write check. Point-read saved events and compare full identity/payload on
retry; changed payload/id reuse is 409. Archive carries `expectedArchivePosition` for
that conversation/join so stale opposite choices conflict. Unrelated changes in the
member's preference stream may safely retry the conditional append within a bound.
Read commands merge by maximum verified position; an old device cannot move it back.
Validate the target event belongs to this visible conversation and is already loaded;
a browser-provided position never grants access. Coalesce markers after visible rows
are applied, not on list fetch, background delivery or merely selecting the route.

Close makes one conditional append on the same content stream as send/upload. Load
command facts with their ten-second budget first; a competing append requires fresh
validation. Concurrent close requests return the stored first close to currently
authorised closers. Saved-command retries return their own receipt, not a new event.
Participant commands on their separate stream check close at final admission. Preserve
the P4-5 default: an already admitted concurrent access mutation may finish, but cannot
reopen or enable new content. Removals remain available to revoke access after close.

Turn start is also a separate computer-stream append. Do not claim an atomic close/start
transaction. Read close before admission and again before issuing a grant; inspect only
new semantic close/turn records after the checked position. A start admitted just before
close can commit, but receives no later renewed authority and remains cleanup work.
An effect already dispatched may complete and be charged. Cover every interleaving.

Reads check current access once; they use no `authorityFence`. Before writes/turn
starts record only small member, participation, assistant, team/payer and grant stream
positions that actually grant that operation. Never watch the whole conversation as
access, especially for personal sessions or any read/view check. Load history and cold
summaries first, outside the two-second check. Use the content stream position only
for conditional append or an incremental semantic-close check. Read-marker churn is
not access churn. Keep socket access polling independent of slow content reads.

Extend rebuildable `conversations` metadata with first-close references and explicitly
folded activity anchors. Add `conversation_list_state`, keyed by silo/member/chat/join
event, for archive/read state and command references. Index message/activity positions
for visible titles and unread entries; SQL only selects/stores these TypeScript-folded
results. Recent activity means creation, visible posted/completed messages and close;
not token deltas, computer readiness, read markers, archive or internal cleanup.
Derive titles from the caller's first visible message; never use pre-join text.
Count other people's human messages and completed assistant messages once by message
id; own messages, deltas and cleanup do not inflate unread. Turn failure is separate.

List GET: default 20/max 50 rows, search `q` at most 100 characters, recent/archived
filter and a bounded continuation. Check candidate access in the existing batches of
eight before decrypting titles/searching or returning metadata. Examine at most 100
candidates per request; an empty authorised page can still have a continuation.
Search only authorised visible titles. Do not return hidden totals or the frame's
illustrative archived count without an authorised count contract.
Sort by last visible activity descending; sequence supplies stable ordering. Bind a
cursor to caller, filters, projection generation and list revision. Reuse the local
HMAC cursor pattern with a chat-specific purpose; include only scan positions, not
denied ids/titles. If activity, participation or archive changes ordering, return 409
`list_changed` and refresh from page one. No stale offset paging or frozen access grant.

Projection effects, event receipts and checkpoints commit together. Extend the existing
offline conversations rebuild to include the new state tables, replay old creation/
participant events and preferences in order, and increase its generation. Rebuild
performs no cleanup, provider calls, computer wake or other reactions. On normal worker
restart reconcile unfinished close intent from the log; SQL jobs are retry receipts,
not truth. Durable read markers survive rebuild; HTTP/socket delivery cursors reset.
Verify referenced event identities rather than trusting a restored numeric position.

Transport loss means outcome unknown. Check the original command id; do not substitute
a new id or show archive/close as confirmed locally. Extend change reads to find the
caller's preference stream and verified stored close, even before projection catches up.
Return append receipt and projection/cleanup state separately. Not found is not proof
that nothing committed. Refuse lost-access status reads without exposing the outcome.

## 4. Screens and API mapping

All additions use existing session/Origin protections, strict protocol and no-store.
Proposed preference POST `/api/conversations/:id/state` accepts either
`{id, action: archive, archived, expectedArchivePosition, joinEventId}` or
`{id, action: read, throughPosition, throughEventId, joinEventId}`.
Proposed close POST `/api/conversations/:id/close` accepts `{id}` only.
Extend messages/list metadata with `closed`, closing evidence, `canClose`, current join,
archive/read state and cleanup status; keep turn status and computer state separate.
Change GET remains `/api/conversations/:id/changes/:commandId`, authorised on every read.

History/live handoff uses the last row actually applied, never a page's projected
position as a shortcut. Drain each 100-row page, deduplicate by event id/position,
then subscribe from that position and generation; socket replay covers intervening
events. On `resync`, discard delivery cursors and reload currently authorised history.

| Frame | Contract and presentation |
| --- | --- |
| THR-01 | Extend `GET /api/conversations?section=recent\|archived&q&cursor&limit`; immutable routes resume existing chats. Empty/no matches only after authorised paging is exhausted; Clear search resets cursor. |
| THR-02 | Same bounded GET; preserve loaded rows during Load more, stop duplicate requests, announce loading once. Reset/reload on list revision conflict. |
| THR-03 | Existing messages GET `?since` plus `/ws` positions/generation; retain loaded content on transient read failure. Retry reads only. Say caught up only after server ready and all pages applied; expose the full wrapped title. |
| THR-04 | Missing/foreign/never-authorised id: existing generic 403 refused and one unavailable screen without title, names, counts or filenames. IAM/service outage remains retryable; not a false revocation. |
| THR-14 | State POST archives/unarchives one person. Close review uses `canClose` and names permanent scope; close POST plus change GET confirm original reference. Cancel/escape makes no command. Show unknown/checking distinctly. |
| THR-15 | First-close evidence from messages metadata/event: who, when, lock plus Closed; replace composer with read-only notice. Keep transcript subscription, archive controls and authorised saved file reads. |
| THR-16 | Genuine denial or socket refused/1008 clears transcript, drafts, titles, participants, filenames/previews, read/delivery cursors, pending actions and cached list row. Abort requests, invalidate local request generation and ignore late HTTP/socket/status replies. |

At 390 px use the existing 56 px bar and 44 px menu trigger; Recent/Archived opens
in the shared navigation overlay. Close review fills the phone viewport with labelled
Back/Cancel and a full-width close action; trap focus, start on its title and return
focus to the opener or surviving heading. The reference's clipped secondary button
must not require horizontal scrolling. Wrap long titles/consequences and make all
targets at least 44 px. Dock open-chat composer above the real keyboard/safe area;
closed/unavailable states have no composer or illustrative keyboard. Use words plus
glyphs, linked errors, polite status announcements and static reduced-motion loaders.

## 5. Ordered PRs, each independently landable

Land sequentially, server before screens, at most two dependent PRs open. The requested
split overrides the standard's usual whole-feature PR. Ceilings below count all
non-generated additions/deletions, tests and docs; do not compress code to meet them.
The original 1,000–1,400-line issue estimate does not account for the gaps found here;
recommend a revised ceiling of about 3,900 across this split; measure each actual diff.

| Order / ceiling | Complete outcome | Failing-first tests to write before implementation |
| --- | --- | --- |
| 1 / 350 | Preference event/projection/rebuild contract, activity anchors and permanent closing evidence; no new commands. | Replay legacy/current joins, re-add, preference changes and late reports; identical closed/list/read results after rebuild; no reactions during replay. |
| 2 / 500 | Bounded authorised recent/archived/search backend replacing the unbounded list. | Order by visible activity; zero metadata from denied/pre-join rows; bounded scan and empty continuation; changed ordering/rebuild resets pages; personal sessions still list. |
| 3 / 400 | Durable archive/read commands and verified status reads, usable across devices. | Same-id lost reply/retry saves once; changed payload conflicts; stale opposite archive conflicts; read maximum never falls; removed/re-added member cannot restore old state; no turn/wake/reservation. |
| 4 / 450 | Close-safe admission, report acknowledgements, output freeze and permanent status, exercising stored close events without public close. | Close races preparation/start/token/context/approval/model call; late start gets no grant and other member continues; contiguous report replay; post-close output cannot change displayed text/status. |
| 5 / 600 | Restart-safe close reconciliation, queue/actual-turn cleanup and idle tracking, still no public close. | Crash between agent/computer terminal appends; queued cancellation once; interrupt/load-drop lost reply; offline/lost generation; private process exit; no premature suspend or other-session interruption; spend remains held/settles once. |
| 6 / 400 | Public close API after cleanup exists; authorised historical files remain readable, live views end. | Direct/group/session close matrix; send/upload CAS race; concurrent closes converge; close retry cannot reopen/re-add; saved files keep same rights; affected viewer ends, other views survive; active chat/file churn preserves readers. |
| 7 / 450 | Server-backed Recent/Archived/search/pagination screens, archive controls and immutable resume routes. | THR-01/02 at 1280/390; empty/loading/empty continuation/long title; two-device archive; unknown outcome checks original id; no local flag as authority. |
| 8 / 400 | Durable read acknowledgement, history/live catch-up and revocation purge in existing workspace. | Multi-page refresh/reconnect has no gaps/duplicates; mark only rendered rows; old device/re-add/rebuild; blocked read during removal; late list/history/socket/status cannot repopulate; THR-03/04/16 keyboard/phone. |
| 9 / 350 | Close review and read-only workspace, THR-14/15, completing the journey. | Permission hides unavailable close; Cancel/Escape/focus/390px; lost ack Check status; close while working; closed remains readable/archivable after refresh; parent/child independence contract fixtures. |

Each server prerequisite handles existing/stored events safely before an action is
exposed; no unfinished control lands. Reuse real NATS/PostgreSQL/OpenFGA fixtures and
recording upstreams; test observable access, history, work and cents, not helper shape.
Each implementation PR updates affected people/robot READMEs and diagrams, catalogue/
wire contracts and one branch-named `changes/unreleased/` file. Later implementation
must pass lint/typecheck/test/check:events and relevant web build under `nice -n 10`,
independent review and green CI. No full root suite during live-view qualification.
Fresh-install journeys cover two devices, all modes, close during work, computer loss,
file/view rights and 390px. Source-ready and live-done remain separate. All NOT RUN here.

## 6. Open questions with recommended defaults

- Who closes? Either participant in direct; active creator in group; requester in
  personal/member session. No Owner/Admin bypass. A departed group creator leaves
  survivors able to read/send/archive but unable to close; explicit transfer is later.
- Does activity unarchive? No. Opening/sending and incoming work leave archive unchanged.
- What survives re-add? Retain old events privately, but reset list/read choices for
  the new join. Shared-child history policy does not restore an old authority interval.
- Closed file reads? Allow already saved authorised assets, keeping every existing
  file restriction. Close removes execution, capture and writes, not retained evidence.
- Close while work runs? Read-only immediately; show cleanup pending until actual end.
  Uncertain external spend remains visibly held and resolvable, never automatically refunded.
- Strict close versus cross-stream mutations? Use the stated admission-time ordering;
  test admitted races and deny new grants/calls. Strict multi-stream atomic ordering
  would need a separate event-store design, not a conversation access watch.
- Parent/child close and later delegation? No conversation cascade. Stop-tree in #93
  operates on the execution tree and shared allowance; it must not close independent
  child conversations or reuse a conversation-close receipt as a new root grant.
- Search, unread and totals? Visible titles only; count completed messages, not tokens.
  Omit unqualified totals. Refresh pagination when ordering changes rather than promise
  a snapshot the current read tables cannot provide.
- Resume private context? Reuse #96's safe fresh-thread recovery and disabled memory
  admission. Never replay uncertain work, load another member's thread or persist context.
