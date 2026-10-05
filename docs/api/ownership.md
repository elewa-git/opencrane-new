# Ownership HTTP interface

P4-2 backend for PPL-32–35. A verified silo session is required. Read routes allow
current Owners and Admins; only a current Owner may appoint or step down. POST
requires the configured application Origin. Roles in session claims grant nothing.
Responses use `no-store`. No UI is included; the screens follow foundation #130.

| Method and route | Input | Result |
| --- | --- | --- |
| `GET /api/ownership` | None | `{ status: "current", owners, sequence, viewer, ready }` |
| `POST /api/ownership` | `{ action: "transfer", commandId, expectedSequence, successorId }` | Durable receipt; successor becomes an Owner and previous Owner remains |
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

Upgrade with writers stopped. Drain or explicitly rebuild all queued, active,
retrying and failed legacy IAM jobs before changing their ordering keys; stopping
the dispatcher alone is insufficient. Deploy the updated event registry,
projection and handlers together. The dispatcher subscription manifest changes;
use its existing controlled rebuild procedure, preserving ordered delivery. Member
and ownership IAM jobs now share one silo ordering key so a seed cannot overtake
legacy owner changes; other handler keys remain per entity. The
server startup performs the idempotent owner-set migration before serving edits.
Its single seed append fences both the ownership stream and captured global head;
a concurrent write refuses migration, so retry startup with writers stopped.
An empty install waits for the bootstrap claim's independently retried seed reaction.

Legacy owner additions/removals/demotions belong only before this seed. After it,
member and OpenFGA projections reject owner-changing member events. Invitation
acceptance refuses an Owner role and any rewrite of active membership. P4-3 must
route future owner edits through this ownership invariant; its non-owner role and
safe removal commands are not part of this interface.

Replay members to rebuild roles, identities, owner sets and feed deltas; replay
OpenFGA to rebuild the same tuples and receipts. Ownership reactions do not run
on replay. Authority reads use exact member and ownership subjects within the
shared two-second fence. Gateway decisions include relevant ownership receipts;
Owner/Admin commands use the ownership-derived role and refuse missing IAM receipts.

[Source evidence and remaining qualification](../process/p4-2-backend-evidence.md)
record the tested seams. Desktop/390px states and fresh-install journeys remain
NOT RUN for this backend change.
