# Shared assistants HTTP interface

P4-7 backend first half: group ownership, explicit resource grants, one computer,
private member sessions and fixed paying-group admission. Screens, personal MCP
credential profiles and fresh-install Codex qualification remain pending.

All routes require a verified silo session and current silo membership. Creation
and command receipts require Owner/Admin. POST requires the configured application
Origin. Responses use `no-store`; session role claims cannot grant access.

## Assistant selection and creation

| Method and route | Input | Result |
| --- | --- | --- |
| `POST /api/assistants` | `{ commandId, assistantId, groupId, name, grants }` | `{ status: "appended", assistantId, sequence, changeId }` |
| `GET /api/assistants` | None | `{ rows }`: all group assistants for admins, current authorised group assistants for members |
| `GET /api/assistants/:assistantId` | None | Same envelope, zero or one row |
| `GET /api/assistants/:assistantId/changes/:commandId` | Original command id | Append receipt plus `projection: { content, iam }`, or 404 |

Ids contain 1–200 letters, digits, underscores or hyphens. Names are trimmed,
non-empty and at most 200 characters. `grants` has 1–32 objects, each containing
`resourceType` (`model` or `mcp_server`) and `resourceId`. Resource ids additionally
permit dots for existing model names. Models must be active catalogue entries;
MCP resources must have an existing event stream. Registration and grants alone
never make an unpublished, blocked or credential-dependent tool executable.
Unknown fields are refused; callers cannot choose computer ids or generations.
Creation bodies are limited to 8 KiB; oversized requests return 413.

Creation makes one conditional append to `assistant-<assistantId>`:
`assistant.created` with `kind: "team"`, `ownerId: groupId`, `name` and the explicit
resource selection. Same-command, same-payload retries return the original receipt.
Changed retries, existing assistants and racing creation commands return 409.
Use another assistant id explicitly to request another computer.

The existing claim reaction owns `computer-<assistantId>`. Duplicate delivery
cannot claim another computer; Pod loss rotates the generation through the normal
lifecycle. The grant reaction separately appends `grant.given` for the assistant
and its owning group to each selected resource stream. Existing grants and
revocations win over replayed creation. Unselected resources receive no assistant
grant. Historical team creation events without a selection grant no resources.
Grants keep assistant and group identities separate even when their ids match.
Existing revocations have no identity kind and continue to deny every matching id;
creation replay cannot restore them.

Rows contain `assistantId`, `ownerId`, `kind`, `computerId`, `generation`,
`status`, `changedAt`, optional `name`/`grants`, and `busy`. Lifecycle status uses
`claiming`, `starting`, `ready`, `suspended`, `lost` or `retired`. `busy` means at
least one recorded admitted turn is still open; it does not expose another
member's conversation or prevent concurrent private sessions. `grants` describes
the recorded selection, not current tool permission. Computer projection rows
are rebuilt from events. IAM replay restores group `acts_for` and resource grants.

The change receipt's `content` and `iam` describe application of the creation
event only. They do not confirm grant reactions, readiness or successful execution.
Read the original receipt after a lost acknowledgement; 404 does not prove an
in-flight command cannot still commit. Retry only the original ids and payload.

## Private member work and paying group

Use the existing chat routes:

| Method and route | Input | Result |
| --- | --- | --- |
| `POST /api/conversations` | `{ id, conversationId, assistantId, payingGroupId }` | Existing conditional append receipt |
| `POST /api/conversations/:conversationId/messages` | `{ id, text }` or `{ id, stopTurnId }` | Existing message/stop receipt |
| `GET /api/conversations` | None | Only the requester's permitted sessions |
| `GET /api/conversations/:conversationId/messages` | Optional `since` | Authorised private transcript |

Shared work requires an explicit payer and current membership in both the owning
group and paying group. Creation fixes the creator and payer. A private session
cannot be read or resumed by another member, including an administrator or someone
with an accidentally added participant tuple. WebSocket transcript delivery uses
the same requester check. Never add participants to share private execution;
shared child transcripts belong to later tickets.

Admission rechecks exact member, assistant, conversation and relevant group
subjects with the existing two-second authority fence and shared read deadline.
Missing, changed or unapplied authority refuses. Each admitted thread belongs to
one requester and conversation on the assistant's computer. The bridge resumes
only matching requester history; old journal entries without requester metadata
start a fresh context when production supplies a requester.

Simultaneous private sessions use separate short-lived tokens. Gateway checks
retain the live computer generation, thread, conversation, requester/assistant
intersection, delegation, grants, tool mode/approval and budget. Swapped thread
tokens and altered requester claims refuse before upstream dispatch. The existing
budget actor reserves and settles integer euro cents. Shared payer binding survives
turn retries; a changed payer on a creation retry refuses even if authorised.
Personal turns retain the installation's configured default and recorded retry
binding. Desktop access still needs a separate `shared_desktop` grant.

## Refusals and qualification limits

401: no session. 400: invalid input. 403: wrong Origin/silo, role, group membership
or requester. 409: changed retry, existing assistant or concurrent creation.
503: unavailable infrastructure or invalid history. Protected error responses
contain only a sanitised `status`. Some existing chat refusals also explain payer
configuration without disclosing protected content.

Memory stays disabled. Main currently admits only credential-free MCP connections;
this slice supplies no invented personal profile or company fallback. Two real
requester profiles at a recording MCP upstream, actual pinned Codex/gVisor context
isolation and fresh-install journeys are **NOT RUN**. See the
[source receipt](../process/p4-7-backend-evidence.md) for checks and remaining work.
