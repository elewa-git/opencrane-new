# Direct person-to-person chats

Backend contract for [P4-4 / #86](https://github.com/elewa-git/opencrane-new/issues/86).
The Claude Design THR screens bind here after the shared UI foundation. No screen
is delivered by this change. Conversation mode and its two participants are
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
| `GET /api/conversations/:conversationId/messages` | Optional `since` (non-negative position, default 0) | `{ rows, position, generation, computerState }`. Up to 100 events after `since`, ordered by position. Direct `computerState` is `not_applicable`. Message rows expose decrypted text and recorded author. |
| `GET /api/conversations/:conversationId/changes/:commandId` | The original send `id`, or a persisted creation `id` to inspect projection progress | `{ status: "appended", conversationId, commandId, type, sequence, projection: { content, iam } }`, where each projection is `current` or `applying`. Current participants can check a creation before its tuples arrive. No text or new append. |
| WebSocket `/ws` | `{ type: "subscribe", topic: "conversation", conversationId, since, generation? }` | Existing version-1 `event`, `ready`, `resync`, `refused` envelopes. Cookie and configured Origin required. Direct `ready` reports `computerState: "not_applicable"`. |

Create nothing while the To line is a draft. On first send, create the direct
conversation, wait for its IAM projection, then send the message as a separate
command. Each command makes one conditional append to one conversation stream.
Retain both original ids through transport loss. An identical retry returns its
original sequence; changed content, colleague or caller with that id refuses.
An active original creator can retry a persisted creation after closure or the
colleague's removal; a new creation still requires two active members. New messages
also require both participants to remain active. This prevents messages building
up for a departed recipient who could read them on rejoining with the same id.
Retries of persisted messages still report the original append. Creation
does not reopen a closed conversation or add people.

For a creation Check status, retry `POST /api/conversations` with the same ids
and payload. This safely checks both a persisted creation and one that never
reached the event store: the retry returns the original sequence or creates it
once. A missing creation cannot be checked through the status GET because there
is no recorded audience to authorise.

For a message Check status, use the GET above with the original id. HTTP 404 `not_found`
means no matching command is currently recorded in an authorised conversation;
it does not prove an in-flight request cannot append later. Poll the same id.
`appended` proves persistence, not receipt or reading by the other person. There
is no per-recipient delivery/read receipt in this contract.

After each history page, use the last returned row's position as `since` until
caught up to `position`; the latter is the stream's projected head, not the last
row in a full page. Reconnect with the last consumed position and generation.
A rebuild changes generation: `resync` requires clearing the old cursor and
reloading. Clear protected content on access refusal and reject late responses
from an obsolete subscription/page. A plain read failure may retain loaded
content only while access remains valid.

Both HTTP and subscription checks read exact member/conversation subjects and
use the shared authority deadline. Removal denies history, posts and status
without waiting for IAM projection, and ends subscriptions within two seconds.
Subscriptions read exact subject heads each tick and repeat the full access
check only when a head changes. Every batch fences access after loading content. An unavailable
permission check grants no access. The recorded direct mode gives
`computerState: "not_applicable"` even while content projection is applying.
Only audience and member-state events change chat access. Turn activity, files,
closure and ownership changes preserve a reader's access. A changed or expired
fence returns retryable HTTP 503, or closes the socket with 1013; neither reports
an access refusal. Model and approval authority keep their strict cancellation
fence. Replays rebuild content and both participant
tuples without waking computers or dispatching work. Legacy creations without
mode still read as `agent_session` with their recorded assistant.

HTTP failures are 400 invalid shape, 401 unauthenticated, 403 non-disclosing
access refusal, 409 changed retry/closed/concurrent state, and 503 unavailable.
Unknown, foreign and nonparticipant conversation reads share the 403 refusal.
Unsupported mode edits, assistant binding, participant changes and Stop commands
cannot mutate a direct conversation. Closed conversations remain readable while
current membership permits it. Group chat and lifecycle commands belong to
P4-5/P4-6; existing assistant sessions keep their creation/send behaviour.

Source and qualification evidence: [P4-4 backend receipt](../process/p4-4-backend-evidence.md).
