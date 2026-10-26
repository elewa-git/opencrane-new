# Human group chats

Any active silo member can create a group chat, including someone without a
personal assistant. The creator reviews and records 2–97 distinct participants,
including themselves. An IAM group association never grants chat access or changes
its audience after creation. Only recorded, currently authorised participants can
read or send. Owners and admins have no private-history bypass.

| Route | Request and reply |
| --- | --- |
| `GET /api/chat/groups` | Optional `q` (name substring, at most 100 characters), `after` (group id), `limit` (1–50, default 20). Returns `{rows: [{groupId, name}], next}` for the caller's own groups. |
| `GET /api/chat/groups/:groupId` | Returns `{groupId, name, position, members: [{memberId, displayName}]}` with currently active people. Groups above 97 people return 409 with guidance to select colleagues instead. |
| `POST /api/conversations` | `{id, conversationId, mode: "group", participantIds, groupId?, groupSnapshotPosition?}`. The two snapshot fields must appear together. The selected ids must match the reviewed group. Returns `{status: "appended", sequence}` after one conditional append. Body limit: 32 KiB. |

Ids contain 1–200 characters, without dots, whitespace or NATS wildcards. Conversation
ids also refuse the reserved `provider-` prefix. Public chat routes refuse conversation
and command ids starting with `routine-session-`, including `routine-session-create-`.
Invalid or mixed bodies return 400.
A changed snapshot or changed retry returns 409. Missing, foreign and unowned groups
return the same generic 403. Unknown, foreign and removed participant ids also return
403 with only `{status: "refused"}`. Every response uses `Cache-Control: no-store`.

Creation checks current membership for every selected person and watches their small
member streams. A group selection also checks its reviewed position and watches that
group's stream. Group changes require a new explicit review. A saved creation retry
compares the original ids, principal and payload; ordering of participants does not
matter. It returns the original sequence even after group membership changes.
A lost reply never refreshes the audience, re-adds someone or reopens the conversation.

The [existing chat routes](direct-chats.md) provide list, messages, status and live
updates. Wait for creation permissions before sending the separate first message.
Group rows retain `mode: "group"` and recorded participants. Feed replies report
`computerState: "not_applicable"`. Plain text, including literal `@agent`, creates
no turn, wake, upstream call or spending reservation. Stop and execution-mode fields
are refused. The [participant routes](direct-chats.md#group-participants) provide
creator edits and self-leave.

## Child-only invitations

The same participants GET and POST routes support shared child chats. GET returns
current recorded participants and `accessPosition`. Only the recorded creator,
with current inherited child read access and OpenFGA `manage_participants`, can
invite or remove others. An admin has no bypass. Other participants can leave.

An addition requires `{id, action: "add", participantId, expectedAccessPosition,
historyReleaseAcknowledged: true}`. The acknowledgement confirms release of all
shared child history from creation, including the first shared input. It grants
no parent messages, participants, files, approvals or other resource permissions.
Ordinary group requests keep their existing shape and reject this acknowledgement.

The server records `participant.added` with `contextKind: "shared_child"`,
`joinKind: "explicit_child"` and `reviewPosition` equal to the reviewed
`expectedAccessPosition`. Remove and leave keep their existing request shapes;
their events carry `contextKind` and `reviewPosition`, without `joinKind`.

A missing or false acknowledgement returns 400. A stale review, an already recorded
target, a full audience of 97 or a closed child returns 409. Inactive targets and
unauthorised callers receive the generic 403 refusal. Permissions outages return 503.
History loads within ten seconds before a separate two-second write check watches
only member and participation streams. No conversation content stream is watched.

Retrying the same id and payload returns the original sequence without another
append. Changed saved payloads return 409. An authenticated active silo member can
recover their own saved self-removal through the same POST after leaving. This returns
only the saved result; messages, participants, files, approvals and sockets remain
unavailable. Another caller cannot recover that self-removal. The existing `changes/:id`
route confirms the join and whether content and IAM have caught up. New joins wait for their IAM
receipt; removals end HTTP and socket access within two seconds, before IAM catches up.
Joining the parent later cannot restore a removed child join. A new explicit
invitation is required. An explicit child join survives parent or creator departure.

## Reviewed child publication

`POST /api/conversations/:child/publication-review` accepts strict
`{publicationKind: "final" | "interim", resultEventId?, text, fileIds?}`. Text is trimmed and must
contain 1–32,000 characters. Any file list, including an empty list, returns
409 `files_unavailable` without file details.

Final reviews require a visible saved `agent.message_completed` from a restricted
shared-only turn with `agent.turn_completed`. Interim reviews accept a saved
`agent.message_completed` while that turn is still open, or human-written text with
no `resultEventId`. A sourced review refuses `agent.output_lost` or `agent.turn_failed`
for that turn. Deltas and final results labelled interim are refused. The publisher
must read the child, post to its open immediate parent and see its original source
message there. A closed child can still publish. Review returns `status: reviewed`,
`text`, `publicationKind`, `parentConversationId`, `audience` (member ids),
`publishedBy`, signed `review` and `expiresAt` (Unix milliseconds). It saves nothing.
Cancel needs no request. The review expires after ten minutes and binds the exact
text hash, kind, publisher, silo, parent, child, optional result id/position/turn and
parent access position. A sourced interim review becomes stale when its turn completes.

`POST /api/conversations/:child/publications` accepts strict `{id, review, text}`.
It records one `conversation.child_result_published` encrypted with the parent's key
and returns `{status: "appended", sequence}`. The recorded origin chooses the parent.
The existing parent `changes/:id` GET confirms the save after projection.

An identical retry returns the saved sequence even after expiry or an audience change,
while requiring current child and parent read access. Changed input under that id,
edited text, expired review, moved, lost or failed result or changed audience returns 409
`review_stale`. Unrelated messages do not invalidate review. Parent closure returns
409 `parent_closed`. Unknown, foreign, non-child, denied or substituted ids and reviews
return the same 403 `{status: "refused"}`. Outages return 503 `unavailable`.
Malformed input returns 400. Replies use no-store and writes check the website Origin.

History loads before the short write check watches only member and participation
streams. New publications sample the global log position and read later child and
parent events before that write check. The parent append atomically requires the
sampled global position and parent position. A definite conflict repeats these reads
and checks within a ten-second limit. Output loss or terminal failure for the selected
turn refuses publication; unrelated child activity does not invalidate the review.
Sustained concurrent writes can exhaust this limit and return 503 `unavailable`.
Parent messages and sockets show text, `authorId`, `publicationKind` and
`contentType: "text"` to all current parent readers. They omit the child link, result,
turn and review digest. Publication starts no computer or model work.

## Reviewed child requests

`POST /api/conversations/:parent/child-review` accepts `requestId`, `sourceMessageId`,
`assistantId`, `participantIds` and optional `allowanceBoundCents` (1–1,000; default 1,000).
The source must be the caller's own visible human message in an open group. The audience
includes the caller and only current participants who could read that message.
The assistant supplies its recorded payer. The reply includes the reviewed fields,
`payingGroupId`, `review` and `expiresAt` (Unix milliseconds). The signed review lasts ten
minutes and binds the caller, silo, parent, source, assistant, payer, allowance and joins.
Review and cancelling in the browser append nothing. Literal `@Assistant` remains text.

`POST /api/conversations/:parent/children` accepts `requestId`, `sourceMessageId` and
`review`. It saves intent, creation and first input separately, then returns
202 `{requestId, state: 'queued'}`. An identical retry checks current requester rights
and resumes missing saves, even after review expiry. Another request id for the same
source returns the original receipt. Changed choices or reused ids return 409 `conflict`.
Changed access during a write returns 409 `review_stale`. Refused reviews return 403;
closed parents return 403 on review and 409 on start. Malformed input returns 400.
An unapplied access receipt returns 425 `access_applying`; an outage returns 503
`unavailable`. These replies may follow a saved intent or creation. Retrying the same
POST can complete them. The server also resumes missing creation and first input from
saved intents after restart, with the original choices and current access checks.
A proven refusal saves `conversation.child_start_failed`, even after parent close.
Recovery stops until an accepted retry; the original start POST alone cannot resume it. An outage or
applying access stays queued and retries with backoff without saving a failure.
`POST /api/conversations/:parent/children/:requestId/retry` accepts exactly
`{retryId, failureEventId}`. Only the original requester can retry, with a visible source,
open parent and current assistant and payer rights. History loads before the short write check.
The 202 receipt is `{conversationId, requestId, retryId, failureEventId, attempt}`.
The event id derives from silo, parent, request and retry id. Same id and body returns
that receipt; changed reuse returns 409. Another retry id for the current failure returns
the first receipt. Missing failure, stale failure and failed attempt 3 return 409.
Unknown requests and another requester's ids both return 403 `refused` without details.
Accepted attempts 2 and 3 resume only missing stages with original ids and choices.
Applying access and outages remain retryable; neither saves a permanent refusal.

`GET /api/conversations/:parent/children/:requestId` checks current parent read access
once after loading history. It returns `{state: 'unknown'}` for missing ids and another
person's ids alike. The requester receives `{requestId, state: 'queued'}` and
`childConversationId` once creation exists. No source text or audience is returned.
A saved failure returns `{state: 'failed', requestId, stage, reason, attempt, failureEventId}`.
Stages are `create`, `first_input` or `activation`; reasons are `access_refused`, `conversation_closed`
or `record_changed`. This reply contains no child id, source text or audience.
Failure and retry records never appear in chat feeds or message history.
All replies disable caching. New children stay held before delivery, computer resume,
start admission and token issue. They reserve and spend zero cents. Activation and
turn admission are not available through these routes yet.

## Child origin

`GET /api/conversations/:conversationId/origin` returns one of these strict replies:

- `{status: "linked", parentConversationId, parentTitle, sourceMessageId, sourcePosition}`
  when the reader can read both the child and its exact parent source message.
  The title matches this reader's Conversations list title.
- Exactly `{status: "restricted"}` when parent access is refused or still applying,
  the source is missing or does not match, or it predates the reader's parent join.

Restricted replies give no reason or parent details. Linked replies contain no source
text or other parent metadata. Removed inherited participants receive 403 even after
rejoining the parent. Explicit child invitations remain independent of parent access.
Missing, foreign, non-child and denied child ids return the same 403 `{status: "refused"}`
as messages GET. Unapplied child access returns 425 `{status: "access_applying"}`.
IAM or store outages return 503 `{status: "unavailable"}`, including parent check failures.
All replies use `Cache-Control: no-store`. This read saves no events or other state.
