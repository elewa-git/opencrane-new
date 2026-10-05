# Shared assistants HTTP interface

Create a group assistant with selected model and MCP access on one computer.
Members get their own chat transcripts. Private turns start fresh execution threads. Screens, personal
MCP credentials and fresh-install checks remain pending.

Memory-free team turns share one disk and one browser profile. Tools can read work
files written by another member. Uploads and attachments into team-kind sessions
are refused until each member has their own workspace. Credentials for individual
members must never be written to that disk or browser profile. Separate threads
and turn tokens do not isolate files or browser logins.

All routes require a verified silo session and current silo membership. Creation
and command receipts require an Owner or Admin. POST requires the configured
application Origin. Responses use `no-store`; session role claims cannot grant access.

## Assistant selection and creation

| Method and route | Input | Result |
| --- | --- | --- |
| `POST /api/assistants` | `{ commandId, assistantId, groupId, payingGroupId, name, grants }` | `{ status: "appended", assistantId, sequence, changeId }` |
| `GET /api/assistants` | None | `{ rows }`: group assistants for admins, permitted group assistants for members |
| `GET /api/assistants/:assistantId` | None | Same envelope, zero or one row |
| `GET /api/assistants/:assistantId/changes/:commandId` | Original command id | Append receipt plus `projection: { content, iam }`, or 404 |

Use 1–200 letters, digits, underscores or hyphens for ids. New team assistant ids
must start with `team-`; this keeps personal assistant ids available. Trim names,
keep them non-empty and at most 200 characters, and do not include NUL characters.
Both the owner group and the admin's chosen paying group must exist in this silo.
They may be different groups. Members confirm that payer when opening a session;
they cannot choose another one.

Supply 1–32 grants. Each has `resourceType` (`model` or `mcp_server`) and `resourceId`.
Model ids may contain dots and must name active catalogue entries. MCP ids contain
only letters, digits, underscores or hyphens and must have an existing event
stream. Registration and grants alone never make an unpublished, blocked or
credential-dependent tool executable. Unknown fields are refused. Callers cannot
choose computer ids or generations. Creation bodies are limited to 8 KiB;
oversized requests return 413.

Creation appends once to `assistant-<assistantId>`. The `assistant.created` event
stores `kind: "team"`, `ownerId: groupId`, `payingGroupId`, `name` and the selected
grants. Same-command, same-payload retries return the original receipt. Changed
retries, existing assistants and racing creation commands return 409. Use another
assistant id to request another computer.

The existing claim reaction manages `computer-<assistantId>`. Repeating the event
cannot claim another computer. Pod loss replaces it through the normal lifecycle.
The grant reaction separately appends `grant.given` for the assistant and its
owning group to each selected resource stream. Unselected resources receive no
assistant grant. Historical team events without selected grants grant nothing.
Assistant and group grants remain separate even when their ids match.

Keep these two grant rules visible in the admin creation review screen:

- An earlier revocation for the same id stops the creation reaction from giving
  that grant again. Creation can still return `appended`; that receipt confirms
  the assistant was created, not that every selected resource became available.
- The owner group also gets person-level use of every selected resource. A member
  can use that resource through the group even after their individual grant was
  revoked. Show this group-wide access before the admin confirms creation.

Rows include `assistantId`, `ownerId`, `kind`, `computerId`, `generation`,
`status`, `changedAt`, optional `name`/`grants`/`payingGroupId`, `canStartSession`, and `busy`.
`canStartSession` says whether the caller currently belongs to both groups needed
to start work. A false value keeps the assistant visible for reading old sessions.
The admin creation review screen must explain this two-group rule.
Lifecycle status uses `claiming`, `starting`, `ready`, `suspended`, `lost` or
`retired`. `busy` means a recorded admitted turn remains open on the current
computer. Loss, retirement or a replacement claim clears old open turns from that
flag. Reading it still scans the computer's event history. It does not expose
another member's conversation or prevent simultaneous sessions. `grants` shows
the recorded selection, not current tool permission. Replay rebuilds computer
rows, group `acts_for` permission and resource grants.

The change receipt's `content` and `iam` describe application of the creation
event only. IAM is the worker that applies access changes to OpenFGA. The receipt
does not confirm grant reactions, computer readiness or successful execution.
Read the original receipt after a lost response. A 404 does not prove an in-flight
command cannot still commit. Retry only the original ids and payload.

## Private chat transcripts and paying group

Use the existing chat routes:

| Method and route | Input | Result |
| --- | --- | --- |
| `POST /api/conversations` | `{ id, conversationId, assistantId, payingGroupId }` | Existing append receipt |
| `POST /api/conversations/:conversationId/messages` | `{ id, text, executionMode? }` or `{ id, stopTurnId }` | Existing message/stop receipt |
| `GET /api/conversations` | None | Only the requester's permitted sessions |
| `GET /api/conversations/:conversationId/messages` | Optional `since` | Permitted private transcript |

Creating a session, posting and admitting a new turn require current membership
in both the owner group and paying group. Session creation records the creator
and the assistant's fixed payer. Personal work retains the installation default.
Historical team assistants without a recorded payer keep readable history, but
cannot open new sessions, post work or spend through old sessions. No payer is
guessed for them.

Reading a chat transcript or listing sessions checks the creator, current owner
group membership and `acts_for` permission at that time. Losing paying-group
membership stops new spending but does not hide old transcripts. A session list checks each assistant once per request. A live socket keeps both
creation events and rereads access only when an access stream changes. They do not use the two-second write authority
fence, which detects access changes before a write. Messages and turn starts or
ends cannot invalidate a transcript read or disconnect its live socket.

The creator check applies to chat transcript routes and their WebSocket delivery.
Even an administrator or an accidentally added participant cannot read or resume
another member's team chat there. File reads also require the creator and current
owner-group membership. Approvals, audit and live view still use their existing
participant checks; they do not add this team creator check. Do not add participants
to private team sessions. Sharing child transcripts is later work.

IAM receipts are needed only for the requester's own membership changes and the
group's creation, not other members' changes. If those changes are still being
applied, HTTP reads return 503 and the live transcript socket closes with 1013.
Retry shortly. A list returns the retryable error rather than silently hiding
that member's sessions. Explicit removal returns 403 or closes with 1008.

Chat history has its own ten-second read budget. Team writes and new team turn
admission open a two-second access check after reading that history. They watch
member, assistant, owner-group and payer streams. Personal posts and turn admission
keep their existing behaviour and have no new access deadline. Stop checks team
ownership and access, but skips the payer because stopping does not spend money.
New team turns require an OpenFGA binding so they cannot skip IAM receipts. Each
admitted thread belongs to one requester and conversation. For memory-free turns, the bridge resumes
only matching requester history. Old memory-free journal entries without requester metadata
start a fresh context on their next turn, including existing personal sessions.
A final membership or payer refusal closes only that turn as failed. The bridge
acknowledges the refusal without a turn token, and the computer drops the waiting
turn. Other members can continue using the same connection. A lost refusal is
sent again after reconnect. Invalid reports still stop the whole computer bridge
until restart. Bridge reconnect behaviour during
simultaneous admissions is tracked separately in [#164](https://github.com/elewa-git/opencrane-new/issues/164).

Simultaneous sessions use separate short-lived tokens. Gateway checks still
include computer generation, thread, conversation, requester and assistant rights,
grants, approvals and budget. Swapped tokens and changed requester claims are
refused before dispatch. The budget actor reserves and settles integer euro cents.

Desktop access needs a separate `shared_desktop` grant. That grant shows the
computer's shared desktop, including every member's browser activity. It does not
provide a private browser profile.

## Private turns and memory-free turns

A message to a team assistant defaults to a private turn (`restricted` on the
bridge connection). It runs in a short-lived Codex process whose home is in RAM.
Shell, file, browser and code tools are off. Shared prompt files and skill
instructions are off in both execution modes, including personal sessions.

The server sends earlier completed exchanges from the same requester only after
admitting the new turn. It leaves unfinished work as a time and `not_completed`,
without its request text. Nothing resumes an old private Codex thread.

An API caller can post `executionMode: "memory_free"` to use tools and the shared
disk. That turn continues its own earlier memory-free thread and receives no
earlier private context. Personal sessions always use memory-free turns. A retry
must keep the same mode as well as the same id and text. Other mode values are
refused. The chat's choice between these modes comes in the next change.

A bridge restart or Pod replacement fails unfinished private work, even if it had
not executed. Nothing repeats it. Memory-free prepared work retries, while
executed work fails. If private reply text disappeared before the server stored
it, the computer reports `agent.output_lost`. A saved text report stays saved when
a later lost-output replay describes that same sequence.

A mode mismatch or private thread reuse within the same requester's session
fails only that turn. Its refused acknowledgement contains neither a token nor
context. Other members keep working. Reporting another member's thread still
closes the bridge connection under the existing thread ownership check.

## Refusals and remaining checks

401 means no session. 400 means invalid input. 403 means wrong Origin or silo,
missing role or membership, wrong requester, or a team upload or attachment.
409 means a changed retry, an existing assistant or concurrent creation.
503 means unavailable infrastructure, invalid history or IAM still applying the
requester's changes. Protected errors contain a sanitised `status`. Some chat and
file refusals explain the payer or upload restriction without returning content.

Memory stays disabled. MCP currently admits only credential-free connections.
This change does not supply personal credentials or a company fallback. Two real
requester profiles at a recording MCP upstream remain **NOT RUN**. Private
Codex/gVisor checks are recorded in the [private-turn check record](../process/p4-14-private-turns-evidence.md). File and browser isolation between members
is **absent**. See the [check record](../process/p4-7-backend-evidence.md).
