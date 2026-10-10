# Ownership HTTP interface

P4-2 backend for PPL-32–35. A verified silo session is required. Read routes allow
current Owners and Admins; only a current Owner may appoint or step down. POST
requires the configured application Origin. Roles in session claims grant nothing.
Responses use `no-store`. No UI is included; the screens follow foundation #130.

| Method and route | Input | Result |
| --- | --- | --- |
| `GET /api/ownership` | None | `{ status: "current", owners, sequence, viewer, ready }` |
| `POST /api/ownership` | `{ action: "transfer", commandId, expectedSequence, successorId }` | Durable request receipt; successor becomes an Owner after confirmation |
| `POST /api/ownership` | `{ action: "step_down", commandId, expectedSequence }` | Durable receipt; caller becomes an Admin, with another Owner remaining |
| `GET /api/ownership/changes/:commandId` | Original command id | Original receipt and `projection: { content, iam }` |

Ids are 1–200 letters, digits, underscores or hyphens. `expectedSequence` is the
non-negative safe integer from the latest ownership read. Bodies reject unknown
fields, including client-selected actor, silo, new role and removal consequences.
An active silo member is required as successor. Unknown and inactive successors
receive `active_successor_required`; foreign history fails closed without disclosure.
Appointing an existing Owner returns `already_owner` (409).

Owner rows contain only `memberId`, event-derived `displayName` and `role: "owner"`.
They are the authoritative owner set; `sequence` is its last event position.
`viewer` contains the caller's member id and event-derived role. `ready: false`
means migration has not seeded owners, so commands are unavailable. These rows
are not a general member directory: P4-3 owns successor selection/search. There is
no verified-identity badge, activity date, group count or dependency inventory.

Every accepted new command makes one conditional append to `ownership-<silo>`.
Step-down changes only the silo role. Group membership, explicit resource grants,
assistant ownership, conversation participation and personal content remain
independent. The existing OpenFGA `owner_role`, `admin_role` and `member` relations
are reused; becoming an Owner grants no private-history or memory access.

A receipt contains `status: "appended"`, `commandId`, `changeId` (the event id),
`sequence`, `recordedAt` (the event's recorded time), `actorId`, `type` and `data`.
Transfer data contains the successor's `memberId` and `transferredBy`; step-down
contains the actor's `memberId`. These provide audit evidence directly from events.
The normal safe organisation audit trail also includes ownership event references.
The recorded time proves the event append, not later projection completion.

Content and IAM each report `current` or `applying`. Show Applying until both are
current; do not turn an append acknowledgement into projected-success evidence.
A status read may omit pending step-down receipts because both Owner and Admin
can read this evidence. Owner additions, membership and migration receipts still
apply; commands require every authority receipt. After a lost response, retain the
original command id and use Check status.

Both GET routes load their results under a ten-second event-history limit, then
check current event-backed Owner/Admin membership and OpenFGA once. A removal
during loading denies the response even if OpenFGA has not caught up. Reads do
not use the two-second write check or compare stream positions. Slow history
and unrelated chat activity do not refuse an authorised caller.

An absent command returns 404 `not_found`; an in-flight append may still finish.
The backend accepts retries of the original command and payload without another
append, even after successful step-down. The designed unknown-outcome state uses
only Check status, never a new submission. A reused id with changed actor/action/
successor returns 409 `command_id_reused`. A stale sequence or race returns 409
`concurrent_change`; refresh and review before a new command.

The last Owner cannot step down: 409 includes `reason: "last_owner"`,
`rule: "At least one owner must remain"` and `action: "appoint_another_owner"`.
Appointment is separate; it never silently removes the previous Owner. 401 means
no valid session; 400 means invalid input; 403 means insufficient/current authority,
wrong Origin/silo or an inactive successor; 503 means infrastructure, migration or
unapplied authority is unavailable. Errors disclose no foreign member details.

## Migration and replay

Deploy the registry, projections and handlers together. IAM job keys remain each
event's subject, so queued member jobs retain their accepted key. The changed
handler subscription manifest still requires the existing
[controlled dispatcher rebuild](../../libs/handlers/README.robot.md#recovery-and-subscription-changes).
This is separate from ownership seeding; no ordering-key migration is needed.

Startup seeding makes at most five attempts, each with a fresh global fence and a
ten-second scan bound. A concurrent append causes a fresh scan and retry. The
single seed append fences the ownership stream and captured global head. If the
bound is exhausted or a dependency fails, the server logs the failure and keeps
serving; ownership commands remain unavailable until seeding succeeds on a later
startup. An empty install waits for the claim's durable seed reaction.

Legacy owner changes belong only before this seed. Afterwards, owner-role values
and owner removal on a member stream are rejected by both projections. A valid
Member/Admin role change that reaches a current Owner has no effect and records
its receipt. The [member role route](members.md#change-a-member-or-admin-role)
refuses Owner targets before append. Step-down requires another owner whose
member events still show active membership. New appointments carry
`awaitingConfirmation: true`. The `confirm-ownership` reaction saves
`member.ownership_confirmed` with the request event id as `appointmentId`.
A removed successor receives no confirmation. An old removal append cannot pass
its member-stream condition after confirmation. Pending requests grant no owner rights.
Both projection statuses stay `applying` until the confirmation has been applied.

Replay members to rebuild roles, identities, owner sets and feed deltas; replay
OpenFGA to rebuild the same tuples and receipts. Ownership reactions do not run
on replay. Commands read history before their two-second access check, then check
only member and ownership stream positions. Ordinary reads check access once. Gateway decisions include relevant ownership receipts;
Owner/Admin commands use the ownership-derived role and refuse missing IAM receipts.

[Source evidence and remaining qualification](../process/p4-2-backend-evidence.md)
record the tested seams and live results. Ownership desktop/390px screens remain
NOT RUN for this backend change.

Existing installations need a stopped-service `upgrade-handlers` run to register
`confirm-ownership` and the new permission subscription, followed by member and
OpenFGA rebuilds. Older appointments without `awaitingConfirmation` keep their
recorded effect. Rebuilds run no confirmation reactions.
