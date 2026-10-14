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
ids also refuse the reserved `provider-` prefix. Invalid or mixed bodies return 400.
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
append. Changed saved payloads return 409. The existing `changes/:id` route confirms
the join and whether content and IAM have caught up. New joins wait for their IAM
receipt; removals end HTTP and socket access within two seconds, before IAM catches up.
Joining the parent later cannot restore a removed child join. A new explicit
invitation is required. An explicit child join survives parent or creator departure.

Child creation, origin and summary routes are not provided by this change.
