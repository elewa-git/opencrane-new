# Flat groups HTTP interface

P4-1 backend for People, flat groups and shared assistants. Group ids reuse team
ids and also identify paying groups. All routes require the verified silo session
and current Owner/Admin membership. POST additionally requires the configured
application Origin. Session claims cannot grant a role. Replies use `no-store`.

## Read and write

| Method and route | Input | Result |
| --- | --- | --- |
| `GET /api/groups` | None | `{ rows: Group[] }`, flat names sorted by name/id |
| `GET /api/groups/:groupId` | None | Same envelope, zero or one group |
| `POST /api/groups` | `{ commandId, groupId, name }` | `{ status: "appended", groupId, sequence, changeId }` |
| `POST /api/groups/:groupId` | `{ action: "add" \| "remove", commandId, memberId }` | Same durable append receipt |
| `GET /api/groups/:groupId/changes/:commandId` | Original command id | Durable receipt and `projection: { content, iam }`, each `current` or `applying` |

Ids are 1–200 letters, digits, underscores or hyphens. Names are trimmed, non-empty
and at most 200 characters, with no NUL character. Write bodies reject unknown fields: there is no
hierarchy, deletion, rename, client-selected role, silo or membership source.
Membership targets must already be active silo members, including removals.

Every new accepted command appends one event conditionally to `team-<groupId>`.
A retry of the same command and payload returns its original receipt without
another append. Altered payloads reusing a command id return 409. Racing commands
have one stream winner; reload after a conflict before retrying a refused command.
Successful appends need not yet appear in the content/IAM projections.

After a lost acknowledgement, retain the original ids and read the change route.
An absent command returns 404 `not_found`; it does not prove an in-flight write
will never complete. Reconcile or retry only the same command and payload.
The change route reads existing event history, not a separate ledger.

## Group rows

Each row contains `groupId`, `name`, `position` (last group event),
`membershipSource` (`local` or `identity_provider`), `payingGroupId`, and `members`.
Members contain `memberId`, `displayName` and their `membershipSource`; removed
silo members are omitted. Supplied identity-provider-managed groups or memberships
are read-only to local commands; missing source in old events means local.

`access` contains `source: "group_membership"`, `conversationAccess: false`,
`personalMemoryAccess: false`, and `grants`. Each grant names `resourceType`,
`resourceId` and `relation` (`use` or `acts_for`). These explain group-derived
grants; live calls still require current silo membership, requester/assistant
intersection, receipts and the other resource-specific checks. The projection
can lag and is not a permission cache. Show an applying change until both
projection statuses become current.

Conversation history requires explicit participation. Desktop access needs both
participation and a separate desktop grant. Shared work binds one group id as
payer at admission and validates membership; personal work continues using the
existing installation default. Budget ceilings/spending stay on the existing
[models interface](../../libs/models/README.md).

## Refusals and recovery

401 means no valid session; 400 means invalid input; 403 means insufficient/current
membership, wrong Origin/silo or IdP-managed membership; 409 means command reuse,
existing/missing group or concurrent change; 503 means unavailable infrastructure
or invalid history. Errors contain only `status: "refused"` or `"unavailable"`.
The status route additionally returns 404 for an absent command. Foreign event
streams fail closed without disclosing their contents.

Revocation fences exact member, assistant, resource and relevant team subjects.
Lagging or unavailable IAM cannot authorise a call. Group-derived desktop sockets
use the existing bounded lease and close within two seconds of removal. A direct
grant remains independent of group membership.

[Source qualification and remaining live work](../process/p4-1-backend-evidence.md)
record the test seams and limits. Screens await Claude Design prompt 4.
