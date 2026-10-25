# Human group chats and participants

Design for #87, 9 October 2026. No product changes or qualification were performed.
Base: `work/p4-5-design`, HEAD and local `origin/main` both
`16bd2b2c5b71e4c60a4166ad5e57e77507450db0`.

## Sources and current position

Read GitHub issues [#87](https://github.com/elewa-git/opencrane-new/issues/87),
[#88](https://github.com/elewa-git/opencrane-new/issues/88),
[#90](https://github.com/elewa-git/opencrane-new/issues/90) and the prerequisite
[#216](https://github.com/elewa-git/opencrane-new/issues/216).
Read the local handoff README and both sizes of THR-06–08, 10–13 and 16 in
`<home>/dev/design-handoffs/v2/05-thr/`.
Read `AGENTS.md`, `plan.md`, `docs/process/standards.md`, the chat parts of
`docs/design/handoff-v2/PLAN.md`, Phase 4 spec/tickets/decisions and ADRs 0001–0006.

The integration plan describes an older baseline. Direct chat backend #159 and
screens #251/#252 are merged. Group backend #137 is merged; its directory is
Owner/Admin-only. Current source also has requester-private shared-assistant sessions.
Reuse `apps/server/src/chat/{commands,access,reads,routes,realtime,chat-summary}.ts`,
the bridge mode guard, `libs/events/src/data.ts`, conversation projections,
`libs/authz/{model/v1.fga,src/members.ts}` and the direct-chat browser components.
`docs/api/direct-chats.md` owns their current wire behaviour.
ADR spike results are historical evidence, not proof of this new capability.

## 1. Meaning and permissions

| Kind | Audience and behaviour |
| --- | --- |
| Direct | Exactly two recorded people; fixed participants and mode. No assistant. |
| Human group | An explicit participant set, optionally associated with one flat IAM group. No assistant binding, payer, turn or computer. |
| Private shared-assistant session | One requester talking to one group-owned assistant. Other group members cannot read it. |
| Shared assistant child, later #90/#91 | Separate `agent_session`, with an explicit shared audience and one selected assistant. It does not change its human parent's mode. |

Any current silo member can create a human chat, even without a personal assistant.
Selecting colleagues records those people plus the creator. Selecting a flat group
offers an explicit snapshot of its currently active members; review the chips before
sending. Only offer groups the requester currently belongs to through the chat picker.
Later IAM joins/removals change group-derived grants, not this chat's participants.
Losing silo membership always removes effective chat access, regardless of tuples.

Only the creator, while still an active participant, can add/remove other people.
Any other participant can leave by removing themselves. Lock the creator chip:
recommend refusing creator leave until a future explicit ownership-transfer feature.
Silo Owner/Admin is not a conversation manager and gets no private-history bypass.
Direct chats cannot become groups; create a new conversation instead.
Keep group mode if its audience shrinks to two or one person.

Initial participants see history from creation. An ordinary late participant sees
only events at/after their latest join position, as THR-13 says. Re-addition starts
a new interval; it does not restore an earlier interval. Removed/left participants
get no history, title, people, files, counts or status reads, including old messages.
Retain events for remaining authorised readers; removal is not deletion.
Previously downloaded content cannot be recalled; clear the application's caches.
The later shared-child exception is deliberate: explicit child joins see all shared
child history, while parent and requester-private content remain separately denied.

Authenticate identity using the verified session, then resolve the member id and
check current member events, participation events and OpenFGA. Cookies, group labels,
browser chips, read cursors and an old creation receipt never confer access.
Refuse missing, foreign and never-authorised ids with the existing generic 403.

## 2. Events, streams and read tables

Reuse existing event names. Extend strict mode schemas, catalogue descriptions,
registry stream ownership and protocol together. No new event type is needed here.

| Event | Data and rule |
| --- | --- |
| `conversation.created` | Group alternative: `conversationId`, `createdBy`, `mode: group`, distinct `participantIds` including creator; optional paired `groupId`, `groupSnapshotPosition`. Neither assistant nor paying-group fields. Existing direct/session alternatives and legacy missing-mode handling remain. |
| `participant.added` | Existing `conversationId`, `participantId`, `addedBy`; creator-only, active same-silo target, currently absent, open group. |
| `participant.removed` | Existing `conversationId`, `participantId`, `removedBy`; creator removes another person, or a non-creator removes themselves. A silo-departed target can still be removed. |
| `message.posted` | Existing `conversationId`, server-bound `authorId`, `authorKind: human`, `contentType: text`, `ciphertext`, `keyId`. Refuse execution-mode/assistant/Stop fields for human chats. |
| `conversation.closed` | Existing `conversationId`, `closedBy`; #88 owns the command. Remains monotonic and never removes read access by itself. |

Bounds: conversation, group and person ids use the member-id format: 1–200 characters,
with no dots, whitespace or NATS wildcards (`*` and `>`). For example, `ext:jane` is
valid. Conversation ids also reject the reserved `provider-` prefix.
New groups have 2–97 distinct initial participants including the creator, and at most
97 current participants. Creation writes one tuple per person plus creator, silo and
event receipt, fitting OpenFGA's default 100-tuple atomic write limit.
Stored-event parsing still accepts older 100-person creations and the older participant
id rules, so a new command limit cannot make saved history unreadable.
Text keeps the existing trimmed 1–32,000 character
limit. Creation body limit 32 KiB; participant command 4 KiB. Bound names to existing
directory limits. Oversized group snapshots refuse with guidance to select a subset;
never silently truncate. Compare sorted ids for retries; order is not identity.

Creation/messages stay on `conversation-<id>`. New participant commands append once
to `participation-<id>`, a small stream containing access changes only (#216).
Row 4 supplies `expectedSequence` for that stream on every append. Concurrent edits
must conflict rather than both admitting a person against the same audience count.
Row 4 must wait for row 2: `approvals.ts`, `view-access.ts` and `files/commands.ts`
currently read participation only from `conversation-<id>`. Their shared access reader
must include the new stream before any participant command is exposed.
Change the two participant registry entries from `conversation` to `participation`.
Existing stored participant events on conversation subjects remain readable during
replay; never append new ones there. Validate exact subject, data id and silo in
each consumer. Do not infer ids by blindly stripping `conversation-` anymore.
Creation initialises participation from its single event; no second append or
synthetic join event is needed. Group association is immutable descriptive context.

Use each stored event's global sequence as its join/end position; no guessed timestamp
or client-supplied boundary. A join starts at its own sequence; removal ends at its
sequence exclusively. Store each interval, join event id and end event id. Read current
authority from creation plus access events, including legacy participant events where
present, not from a stale PostgreSQL row. Check IAM receipts for current joins.
Reject removed people immediately from event state even while IAM still permits them.

Extend `conversations` with rebuildable metadata and participant-interval tables:
immutable mode/creator/association, current participants, closed state, latest activity,
and processed positions. Keep `conversation_feed` as the existing timeline and add
participant events by their data conversation id, ordered by global position.
Fold rules in named TypeScript functions; SQL only reads/writes indexed results.
Projection effects and checkpoints commit together; replay performs no assistant work.

History queries intersect `since` with the caller's current join bound before fetching
or decrypting up to 100 rows. Filter structural rows too: a pre-join creation payload
must not reveal the original audience. Supply authorised current metadata separately.
Titles/previews must derive from the caller's first visible message, not an older first
message. Lists must exclude ended intervals before exposing names or metadata.
Avoid the current full-history summary scan; query indexed visible message/activity
positions. Recent/unread/archive storage and ordering remain #88 work.

OpenFGA keeps `conversation#silo`, explicit `participant: [person]`,
`read = participant and member from silo`, and `post = read`.
Add `creator: [person]` and `manage_participants = creator and read`.
Project group creation's entire explicit audience, never `team#member` into a
conversation. Reuse `team#member`, assistant `acts_for` and resource `use` independently.
OpenFGA checks participation, not history position; the server enforces both.
Each IAM update and its `projection_event#applied` receipt remain atomic.
Order creation and participant IAM jobs by logical conversation id, retaining the
existing creation job key; update that handler's routing for the new subject.
Document draining existing jobs when changing keys; replay supports both old subjects
and the new stream without reapplying an old join over a newer removal.

Creation, send and participant retries return the same event only after matching
principal, mode, ids and payload. Reused ids with altered data return 409. Persisted
creation retry never refreshes a group snapshot, re-adds someone or reopens a chat.
Participant commands carry `expectedAccessPosition`; stale edits return 409 and
require reload, not automatic broadened retries. One click changes one participant.

Existing installations must stop conversation readers and workers, then run
`npm run replay -- conversations --confirm-conversations-stopped` before restarting.
The worker refuses to start when the feed already has creations but either new table
is empty. Offline replay rebuilds the feed, metadata and intervals from the event log;
it runs no reactions. It increases the generation so readers reload. `--verify` is
refused for this offline command. A failed replay can leave a rebuilt prefix; keep
readers stopped and rerun after fixing the failure.

Inconsistent conversation history still stops this projection. When applying an event
fails, the runner logs its id, subject and failure. The transaction rolls back that
event and its checkpoint. Unreadable stored events also stop replay.
Quarantining only that conversation safely needs every reader to check its unavailable
state. Today's readers use the feed directly and do not have that check; skipping a
removal could leave them serving content from incomplete access history. Do not hide
that corruption by advancing the checkpoint. Database failures and missing event-log
positions must also stop replay. Per-conversation quarantine can be added with the
shared reader, after every read path refuses a quarantined conversation.

## 3. Assistant, payer and private context

Ordinary sends, including literal `@agent`, have zero turn/token/wake/model/tool/
approval/budget activity. Extend admission and bridge dispatch guards for `group`;
report `computerState: not_applicable`. Hide assistant, model, memory and Stop controls.
Current human-chat file/desktop operations remain refused; do not advertise uploads,
microphone capture or a computer just because the reference composer has icons.

THR-07 selects one currently permitted group assistant and starts a requester-private
session through the existing shared-assistant flow. The assistant's fixed paying group
is confirmed and recorded; neither the sender's default payer nor parent association
can override it. Recheck owner-group/payer membership and grants at turn admission.
Only actual agent calls use the existing integer-cent budget actor.

Later #90: explicitly select an eligible group assistant on your own visible parent
message; freeze authorised child participants and that assistant's payer in the intent.
Separate one-append commands create child, first input and activation. Lost responses
reconcile the same intent; the human message survives a failed start.
Validate source ownership, current parent/child access, close state and grants again
before activation. Parent removal ends inherited child rights; explicit child-only
invitations confer no parent rights. Keep those cases distinguishable in child access.

Shared children use shared context only: no personal memory/preferences, another
requester's thread, credentials, private transcript, private files or private outputs.
Group memory still needs its separate current scope permission; the parent association
does not grant it. Private-memory-bearing execution and reports stay in private
sessions; an explicit reviewed release is separate #92 publication work (D16).
Run serial shared turns as the current requester, with requester-bound approvals and
profiles. Completion never publishes automatically. No shared-child machinery lands
in #87; its access interface must provide current audience, join bounds and access
positions for #90/#91/#92 to reuse.

## 4. Live updates and the two-second rule

Keep HTTP commands and version-1 `/ws` conversation subscriptions, positions and
projection generations. No new socket service, browser NATS credential or dependency.
Use last consumed row position, not the returned projected head, for the next page.
Drain all 100-row pages before ready; deduplicate by event id/position. Generation
change sends `resync`, clears cursors and reloads only currently permitted history.

Reads check current event-backed participation and OpenFGA once before content.
They do not open an `authorityFence` or watch conversation activity. Each content
page has its own deadline. A slow HTTP read may finish after a concurrent removal;
the revoked browser must discard it. Do not describe that request as atomic revocation.

Writes load command/history facts with their separate existing ten-second deadline,
then start a fresh two-second check immediately before their conditional append.
Reuse `readStreamSummary` for incremental command/closed facts and saved command
positions, point-read the saved event to compare retries, and use `historyChecked`
only after covering the target stream through its expected sequence. Cold replay
happens before the short check. No full conversation scan belongs inside it.
Watch requester member and participation streams; add target member streams for
creation/addition and the team stream only when validating a reviewed group snapshot.
Ordinary chat does not watch assistant/payer/grant streams it does not use.
Recheck relevant heads and receipts at the end; changed authority refuses admission.
Use conversation head as the message append expectation, not as an access fence.

Sockets watch only the caller's member and participation streams for human groups.
Personal fixed sessions do not gain a whole-conversation watch. Shared/private agent
paths additionally watch their actual small assistant/team/grant authority streams.
Poll independently while content is blocked, retaining the current 100 ms interval
and 1.5 s watchdog. A participant removal ends subscriptions within two seconds of
its event append; do not wait for IAM deletion. Unapplied joins expose no content:
425 `access_applying` only for a currently recorded active join; 503 is an outage.

Before sending a drained socket batch, confirm its access version is still current.
Discard the batch if polling discovered revocation during its content read. Send
generic `refused` then close 1008 for true denial; transient failure closes 1013 and
never authorises new delivery. Bind every browser HTTP/socket result to its current
conversation and local request generation; purge transcript, drafts, people, files,
counts, pending sends and cursors on revocation, and ignore late results.
Apply the same participation check to file reads/commands and live-view leases before
the first participant command ships; group mode itself still has no computer/files.

Conditional append serialises one stream, not membership and content together.
A removal can commit just after a send's final access check: a saved message is not
proof of delivery, and removed readers receive nothing. #88 must keep close on the
content stream so a send racing close fails its append expectation. Participant
commands also check current closed state immediately before admission; see the
cross-stream close question below. Turn/file activity never revokes a reader.

## 5. Frame-to-API mapping

All routes below are proposals where labelled new; existing routes retain their
Origin/session checks, strict protocol parsing and `Cache-Control: no-store`.

| Frame | API and visible result |
| --- | --- |
| THR-06 | Existing `GET /api/chat/colleagues?q&after&limit`; new `GET /api/chat/groups?q&after&limit` and `GET /api/chat/groups/:groupId` return own groups and a reviewed member snapshot/position. First send: `POST /api/conversations {id, conversationId, mode: group, participantIds, groupId?, groupSnapshotPosition?}`, wait for IAM, then separate message POST. No saved item during local drafting. |
| THR-07 | Existing authorised `GET /api/assistants` member flow and `POST /api/conversations {id, conversationId, mode: agent_session, assistantId, payingGroupId}`. Reuse private shared-assistant/payer review; no group participant binding. |
| THR-08 | Derive mode before POST: one colleague means direct; several means group; selecting a group means group even with one colleague; one assistant means session. People plus assistant or several assistants disable composer. Server independently returns 400 for unsupported bodies. |
| THR-10 | Existing `GET /api/conversations`, `GET/POST /api/conversations/:id/messages`, `/ws` replay. Extend typed rows to group mode and recorded authors. The reference's Delivered label has no receipt API: show Saved after append, not proof someone received/read it. |
| THR-11 | Existing `GET /api/conversations/:id/changes/:commandId`; same-id creation POST reconciliation. Safe failed send can retry original payload/id; unknown outcome checks original status. 404 may mean projection lag; never send with a new id to resolve uncertainty. |
| THR-12 | Ordinary message POST persists `@agent` as text. No dispatch or child endpoint call. Hide Ask action until #90's real review/start contract exists; use truthful guidance meanwhile. |
| THR-13 | New `GET /api/conversations/:id/participants` returns current people, viewer join position, `accessPosition`, `canManage`, `canLeave`; new POST there takes `{id, action: add/remove/leave, participantId?, expectedAccessPosition}`. Colleague search reuses the existing endpoint. Applying/status uses the existing change route extended to participant events and IAM receipts. |
| THR-16 | Generic HTTP 403 or socket refused/1008 triggers complete purge and focused unavailable notice. Missing/foreign first loads use the same unavailable state without title/names/counts; late responses cannot restore them. |

New chat group reads are member-facing, bounded to 20 rows by default/50 maximum;
they do not weaken the administrative `/api/groups` routes. Resolve a full snapshot
only within the 97-person cap; recheck selected active ids and the reviewed group
position at create. Changed snapshot returns 409 for another explicit review.
All current participants can read the current people list; only creator can mutate
others. A successful leave replies once, then clears the client; later status reads
are denied. Other authorised participants can still reconcile its event.

At 390 px keep the 56 px bar and 44 px menu trigger; rail becomes the shared modal
menu. Wrap names/chips, expand +N into a keyboard-accessible full-screen picker,
and keep creator locked. Picker has labelled Back/Cancel, trapped focus and return
focus; long names, empty/denied/stale selection and applying states remain readable.
Dock composer above the real keyboard/safe area; render no illustrative keyboard.
Use full-width primary actions, 44 px targets, no horizontal scrolling, Enter to
send/Shift+Enter for a line, `aria-describedby` errors and polite status once per
operation. Freeze animation loops and entrances for reduced motion.

## 6. Ordered, independently landable PRs

Sequential landing, server before screens; at most two open dependent PRs. Estimates
include non-generated tests/docs/additions/deletions. Each has a usable contract or
complete internal prerequisite with existing behaviour still working; no unfinished
control or participant command lands ahead of its protection. This requested split
is an exception to the usual whole-feature PR rule; #87 closes after the full journey.

| Order / ceiling | Outcome | Failing-first evidence to add before implementation |
| --- | --- | --- |
| 1 / 500 | Group schemas, participant stream ownership, replayable intervals and IAM tuples/ordering; no new commands. Update catalogue/registry and exact contracts. | Reject mixed modes/duplicate audience; replay creation/legacy/new joins/removal/re-add identically; delayed creation job cannot overwrite removal. |
| 2 / 550 | Shared bounded participation reader and history/title filtering; sockets, files and live views accept its small access stream. No mutation endpoint yet. | Subscribe between removal append and IAM apply, including blocked content, then refuse within 2 s; late join cannot read pre-join text/metadata; 100,000-message history and streaming activity preserve readers. |
| 3 / 550 | Member-facing group picker, explicit snapshot creation, group list/send and human dispatch guards. | Active member without assistant creates; stale/foreign snapshot denies; lost creation reply/retry fixes original audience; sends make zero turn/wake/upstream/reservation events. |
| 4 / 600 | After row 2 updates every access reader, creator add/remove and self-leave commands, CAS/retry/status, with all revocation paths from #216 exercised together. | Non-creator edit/creator leave denies; concurrent stale edits conflict; removed author cannot send; in-flight delivery/cache results are discarded; retry cannot re-add/reopen. |
| 5 / 500 | Extend existing recipient picker/To line for multiple people and own-group snapshots; THR-06–08 and existing agent picker navigation. | No API append before first send; mode derives correctly; mixed selection refuses; stale snapshot requires review; keyboard/390 px long-chip and empty-picker cases. |
| 6 / 500 | Reuse direct human transcript/send/status for group list and authors; THR-10–12/16. | Double Enter saves once; lost ack checks same ids; 100-row pages/reconnect have no gaps/duplicates; late HTTP/socket replies after purge stay invisible; no assistant controls. |
| 7 / 450 | Participant picker and leave/revocation journey; THR-13/16 at both widths. | Creator locked; only permitted actions; stale colleague removed; applying/unknown/status are distinct; phone focus/Back/reduced motion and purge of all protected state. |

Reuse existing real NATS/PostgreSQL/OpenFGA HTTP/WebSocket fixtures and recording
upstreams; assert observable history/rights/counts, not helper shape. Each PR updates
affected README.md/README.robot.md/diagrams and a branch-named unreleased note.
During implementation run required lint/typecheck/test/check:events and relevant web
build under `nice -n 10`; no root suite during live-view qualification. Independent
review/green CI are landing gates. Source ready is separate from fresh-install done.
This task ran none of those checks: tests/build/live desktop/phone journeys NOT RUN.

## 7. Open questions and recommended defaults

- Ordinary late history? Follow THR-13: latest join onwards; explicit shared-child
  late invitation sees all shared child history. Keep the policies distinct.
- Creator leave/departure? Refuse voluntary leave now; no automatic successor.
  Silo departure denies the creator and leaves surviving participants readable and
  able to send, but without participant management. Ownership transfer is later work.
- Group visibility/cap? Offer only the caller's current groups, with a 97-person
  chat cap. Larger groups require explicit colleague selection, never truncation.
- Group-only snapshot of two people? Persist group mode when a group was selected;
  two individually selected people means direct. Never change saved mode later.
- Close versus participant mutation across streams? Recommend admission-time ordering:
  reject if already closed at the final check; an already admitted concurrent mutation
  may finish while close wins, but cannot reopen or enable sends. State this in #88's
  review/tests. If strict atomic rejection after close is required, resolve native
  append ordering before its command ships; do not claim a two-stream transaction.
- Historical participant subjects? Preserve legacy read/replay, prohibit new writes
  there, order IAM by conversation id and document queue draining at rollout. Do not
  migrate or copy historical business events into a second authoritative history.
- Should removal retain earlier history? No: deny all server reads/status and purge
  browser state. Re-add grants a new ordinary interval only.
- Delivered labels and illustrated composer tools? Use Saved for durable append.
  Leave unsupported upload/microphone/computer controls absent; no invented receipts.
- Assistant in the human group? None. Explicit shared child owns assistant/payer;
  group-visible execution has no private memory or private outputs.
