# Direct person-to-person chats

Backend API for [private direct chats / #86](https://github.com/elewa-git/opencrane-new/issues/86).
The planned chat screens will use these routes. This change supplies the backend
only. Conversation mode and its two participants are
recorded together in `conversation.created`; they cannot be edited. Messages are
encrypted at rest with the conversation key; the server decrypts authorised reads.

All HTTP reads require a signed-in active silo member. Writes also require the
configured browser Origin. Silo and caller come from server configuration and
the verified session identity, never request fields. Responses use `no-store`.
An Owner/Admin gains no access to another person's direct conversation.

| Interface | Request | Response / meaning |
| --- | --- | --- |
| `GET /api/chat/colleagues` | Optional `q` (display-name substring, ≤100 characters), `after` (member id), `limit` (1–50, default 20) | `{ rows: [{ memberId, displayName }], next }`. Active members of this silo, excluding the caller. Name may be null; no invented fallback or email. `next` is null or the next page's `after`. |
| `POST /api/conversations` | `{ id, conversationId, mode: "direct", colleagueId }` | `{ status: "appended", sequence }`. Exactly caller plus the selected active colleague. Refuses self, assistant, payer, explicit audience or identity fields. |
| `POST /api/conversations/:conversationId/messages` | `{ id, text }` | Same append response. Trimmed non-empty text, ≤32,000 characters. Only the two current silo members may send. Plain `@agent` remains text. |
| `GET /api/conversations` | No body | Authorised rows with `conversationId`, `createdBy`, immutable `mode`, `participantIds`, `createdAt`, derived `title` and `status`. Direct rows have no `assistantId`; ordinary activity remains `open`. |
| `GET /api/conversations/:conversationId/messages` | Optional `since` (non-negative position, default 0) | `{ rows, position, generation, computerState, computerRecovered }`. Up to 100 events after `since`, ordered by position. Direct `computerState` is `not_applicable` and `computerRecovered` is false. Message rows expose decrypted text and recorded author. |
| `GET /api/conversations/:conversationId/changes/:commandId` | The original send `id`, or a persisted creation `id` to inspect projection progress | `{ status: "appended", conversationId, commandId, type, sequence, projection: { content, iam } }`, where each projection is `current` or `applying`. Current participants can check a creation before OpenFGA applies its permissions. No text or new append. |
| WebSocket `/ws` | `{ type: "subscribe", topic: "conversation", conversationId, since, generation? }` | Existing version-1 `event`, `ready`, `resync`, `refused` envelopes. Cookie and configured Origin required. Direct `ready` reports `computerState: "not_applicable"` and `computerRecovered: false`. |

Create nothing while the To line is a draft. On first send, create the direct
conversation, wait for OpenFGA to apply its permissions, then send the message as a separate
command. Each command makes one conditional append to one conversation stream.
Retain both original ids through transport loss. An identical retry returns its
original sequence; changed content, colleague or caller with that id refuses.
An active original creator can retry a persisted creation after closure or the
colleague's removal; a new creation still requires two active members. New messages
also require both participants to remain active. This prevents messages building
up for a departed recipient who could read them on rejoining with the same id.
A post refused because the other person left returns 409; history stays readable.
Retries of persisted messages still report the original append. Creation
does not reopen a closed conversation or add people.

For a creation Check status, retry `POST /api/conversations` with the same ids
and payload. This safely checks both a persisted creation and one that never
reached the event store: the retry returns the original sequence or creates it
once. A missing creation cannot be checked through the status GET because there
is no recorded audience to authorise.

Message Check status uses the GET above with the original id. HTTP 404 `not_found`
means the matching command is not yet in the conversation read table. The table
may still be catching up, or an in-flight request may append later. The client can
poll the same id, or retry the original POST with the same id and payload. A found row always
reports content as `current`; IAM progress is checked separately.
`appended` means the event was saved. It does not mean the other person received
or read it. This API provides no delivery or read confirmation.

After each history page, use the last returned row's position as `since` until
caught up to `position`; the latter is the stream's projected head, not the last
row in a full page. Reconnect with the last consumed position and generation.
A rebuild changes generation: `resync` requires clearing the old cursor and
reloading. Clear protected content on access refusal and reject late responses
from an obsolete subscription/page. A plain read failure may retain loaded
content only while access remains valid.

HTTP and socket requests check the caller's current membership and conversation
access. Removal denies the departing member's history, posts and status without
waiting for OpenFGA to catch up. It ends their subscription within two seconds.
Each socket poll checks access before reading content. The access check has a
1.5-second time limit; it ends before the content read starts. The server keeps
checking removals while a content read is waiting. An unavailable permission check
grants no access. Direct chats report `computerState: "not_applicable"`, even before
the read table has caught up.

History and status reads check access once, before loading content. Each list row
checks its recorded participants and OpenFGA permission once, with up to eight
rows checked in parallel. A membership or participant change during the content
read does not change that request's result. The next request checks the new access.
Slow content reads and busy conversations do not cause an access timeout.
An unavailable access check still returns 503; a socket closes with 1013 and can
be reconnected. Turn activity, files, closure and ownership changes preserve a
reader's access. Writes read command history with its own ten-second limit, then
open a short access check before appending. Model and approval checks retain
their stricter rules for cancelling work.
Replay rebuilds the read tables and both participants' OpenFGA permissions without
waking computers or starting work. Older creations without a mode still read as
`agent_session` with their recorded assistant.

HTTP failures are 400 invalid shape, 401 unauthenticated, 403 non-disclosing
access refusal, 409 changed retry/closed/concurrent state, and 503 unavailable.
Unknown, foreign and nonparticipant conversation reads share the 403 refusal.
Unsupported mode edits, assistant binding, participant changes and Stop commands
cannot mutate a direct conversation. Closed conversations remain readable while
current membership permits it. Group chat and lifecycle commands belong to
P4-5/P4-6; existing assistant sessions keep their creation/send behaviour.

Source and qualification evidence: [P4-4 backend receipt](../process/p4-4-backend-evidence.md).
