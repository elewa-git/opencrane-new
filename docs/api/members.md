# Member reads

Reads use `no-store`, verified session identity, current events and IAM; they append nothing.

| Read | Access and returned fields |
| --- | --- |
| `GET /api/members/:memberId` | Active Members get only `memberId`, `displayName`, `role` and false management flags. Inactive targets return 404. |
| Same route for Owner/Admin | Adds email, joined status, recorded `joinedAt`, groups with id/name/membership source, `memberSequence` and `ownershipSequence`. |
| `GET /api/members?q=&after=&limit=20` | Owner/Admin-only name/email search. Returns `rows`, `next`, `counts`, `checkedAt`, `projection.content` and `permissions.invite: true`. |

Only Owners get `manageOwnership: true` for the existing ownership API. For an
active non-owner target, Owner/Admin detail replies set `changeRole` and `remove`
to true, including when the caller is the target. Owner targets keep both false.
These flags describe the caller's current role and the target's current role.
Commands still check authority and reviewed positions when sent.
`personalAssistant` and `rejoinedAt` return `{ status: unavailable }`.
The access and departure reads are described below.
The Members tab uses the directory read for search and bounded pages. It shows
only current counts. It keeps loaded rows after an unavailable read and clears
them after a 401 or 403. Each member name opens the detail page. That page reads
the member first and reads access separately only for a full admin detail. A
minimal header shows name and role alone. A 401 or 403 on either read clears all
detail, while a temporary failure keeps the last loaded facts for GET-only retry.

Paging follows colleagues: default 20, maximum 50, query ≤100 characters, ids ≤200 safe characters.
Event checks exclude departed candidates. Pages can be short/empty; follow `next`.
Group reads stop at 100 per person; larger records return unavailable, never a truncated list.

Silo-wide counts are separate from search/pages: `{ value: integer|null, status: current|applying|unavailable }`.
Behind member/group checkpoints mean null/applying. Invitation counts read at most 500 events
within five seconds; either limit means null/unavailable. Pending means latest, unaccepted, unexpired
and inactive. Accepted counts distinct recorded invitation acceptances, including departed people.
Essential errors or the ten-second route deadline return 503. Unavailable counts preserve authorised rows.

The socket checks current Owner/Admin events and IAM on every drain and every 250 ms while content waits.
A 1.5-second watchdog and delivery expiry stop late delivery. Members, demoted Admins and removed people
receive no protected rows. Members use `/api/chat/colleagues`. No conversation stream is checked here.

## Invitation email

`POST /api/invitations/identity` accepts an email for an invitation. The response
says the person is confirmed when they accept.
Only current Owners and Admins may use it. It checks the signed-in session,
the exact Origin, the configured organisation, current member events and OpenFGA.
Cookie roles do not grant access. Its strict body is `{ email }`, at most 1 KiB,
with an email length of at most 254 characters. It appends no events.

A successful response is exactly:

```json
{
  "status": "confirmation_on_acceptance",
  "email": "person@example.test",
  "message": "The person is confirmed when they accept the invitation."
}
```

The email is the Admin's input. The response says nothing about whether an account
exists, whether its email is verified or which organisation it belongs to. It
returns no sign-in subject, name, member id or membership status. The server has
no Zitadel directory credential and makes no directory request.
Missing sessions return 401, access refusals return 403 and invalid input returns
400. Missing services, access-check errors and the ten-second deadline return
503 with `{ status: unavailable }`. Errors never become claims about a person.
This read checks access once and uses no write freshness check.

At acceptance, the server checks the signed-in identity using its issuer and subject.
The ID token must have `email_verified=true`, and its email must match the invited
email after trimming and ignoring ASCII letter case. The organisation check must
pass, including the exact configured organisation. Acceptance keeps the invitation's
member id and records the signed-in issuer and subject. The email-input route does
not create an invitation or grant membership.

## Create and renew email invitations

`POST /api/invitations` records one `member.invited` event. Only a current Owner
or Admin, checked through events and OpenFGA, may create or renew it. The session
must belong to the configured organisation and silo. POST requires the exact Origin.
Its strict JSON body is `{ commandId, memberId, email, expectedSequence, role,
personalAssistant }`, at most 1 KiB. Both ids use 1–200 letters, digits,
underscores or hyphens. `expectedSequence` is a non-negative integer.

Email uses ASCII only, is trimmed and lower-cased, and has at most 254 characters.
For a new invitation, the caller generates a random UUID v4 for `memberId` and
keeps it for retries. The server records it in the event. It identifies a pending
invitation, not an admitted member, and contains no email-derived information.
A new id that is not a UUID v4 returns 409 `identity_mismatch`. Role is
`member|admin`; assistant choice is
required and is `provision|none`. The server supplies `invitedBy`, a stable
`invitationId` from the original command, and an expiry exactly seven days after
the event time. It records no issuer or subject and makes no Zitadel request.

The server finds up to 100 candidates by email in the members read table, then
checks each candidate's event stream. More candidates, over 10,000 events in one
stream, invalid stored data or an event from another silo return 503. It never
scans all member streams. An active candidate returns 409 `already_member`.
A removed stream returns 409 `access_removed`. Renewing a pending or expired
invitation uses the same email and stream, a new command id and its reviewed
position. The email lookup finds the existing invitation; a different body id
returns `identity_mismatch`. A stale position returns `concurrent_change`; changed
saved-command
arguments return `command_id_reused`. History reads finish before the two-second
caller, ownership and target check. The one append uses the reviewed position and
`historyChecked` only after comparing the reviewed position with the last event;
earlier events remain unchanged. If a watched stream changes during the write
check, the server returns the caller's saved receipt if their command is stored,
403 if they lost admin access, or 409 `concurrent_change` otherwise.

Success returns `{ status: appended, memberId, invitationId, sequence, createdAt,
expiresAt }`. An exact repeat returns that receipt without writing. A 503 or lost
reply can follow a stored append. `GET /api/invitations/:memberId/changes/:commandId`
finds only the caller's own original receipt, or returns 404 `not_found`. Another
admin's command also returns 404. This read requires current Owner/Admin events
and OpenFGA, checks access once and appends nothing. All replies
use `Cache-Control: no-store`. Invalid bodies return 400, missing sessions 401,
access refusals 403 and unavailable dependencies 503.

`POST /members/join` accepts these email invitations under the checks below.
No usable link or email is sent. Lists and minimal receipts after self-demotion
remain follow-up work.

## Admission member ids

The server keeps a helper for selecting a member id from an authenticated issuer
and subject. Email invitation creation and acceptance do not call it: they keep
the invitation's member id. Active or pending invitations keep their existing event-bound
ids. Otherwise SHA-256 of JSON `[silo, issuer, subject, admissionNumber]` selects
`admission-<hash>`, starting at zero and skipping removed member streams.
The helper tries at most 20 admissions. Conflicting identity events return
`identity_mismatch`; multiple active or pending bindings return `ambiguous`.
Twenty removed admissions return `admission_limit`.
The caller supplies a read deadline. More than 10,000 member events or any event
from another silo makes the search unavailable. It appends nothing.

The [rework receipt](../process/p4-3-pr2-rework.md) records the checks run for this route.
The complete fresh-install invitation journey is NOT RUN.

## Email-only invitation acceptance

`POST /members/join` accepts an invitation without `invitedIdentity` when the
verified ID-token email matches. It uses the same strict body, organisation,
recent sign-in, current inviter, pending-state and expiry checks as bound acceptance.
The `memberId` in the body must be the invitation's id. The one `member.joined`
event records `identity: { issuer, sub }` from the session and server configuration.
It also keeps the invitation's role, email and assistant choice.

Before the final two-second access check, acceptance finds up to 100 candidate
member ids by issuer and subject in the members projection. It reads the ids and
projection checkpoint in one database query, then reads only member events after
that checkpoint to include accounts the background worker has not applied yet.
It checks each candidate's own events to decide whether the account is active.
An active account returns 409 `already_member`, including when its email changed.
Missing projection tables, over 100 candidates, over 10,000 unapplied member events,
over 10,000 events in one candidate stream, an incomplete read or foreign-silo data
return 503. The event reads have a ten-second deadline. Accumulated unrelated history
before the checkpoint does not count towards these limits.
It never reopens a removed stream. These history reads finish before the access check.

The final check also confirms that no member stream changed since the identity search.
The append uses that same position across `member-*`. Two invitations accepted by
the same account therefore cannot both save a join, even when both requests finish
checking access together. A change on another member stream returns 409
`concurrent_change`; the caller can retry its unchanged command. This check also
refuses unrelated member changes, so acceptance may need a retry during busy periods.

Two accounts can have the same verified email. They compete for the same invitation
stream through one conditional append. The account that stores the join binds the
invitation to its issuer and subject; the other receives 409 `wrong_identity`.
An exact saved-command repeat, including after a lost reply, returns `already_joined`
without another append. Bound invitations retain their existing acceptance behaviour.

## Bound invitation acceptance

The existing `POST /members/join` remains available for invitations already bound
to an issuer and subject. Its strict body is `{ memberId, invitationId, commandId,
displayName }`, at most 1 KiB. It returns `Cache-Control: no-store`.
Acceptance records the invitation's `personalAssistant: provision|none` choice
in its one `member.joined` event. An older invitation without the field means
`provision`. The request body cannot change the choice. `none` skips personal
assistant creation and the computer claim that follows it; it still admits the member.
An exact retry, including after a lost reply, returns the saved join receipt.
It does not rerun assistant creation. Email-only acceptance uses the same request
and records the account binding in the join event.
Fresh acceptance requires the exact Origin and configured organisation, including
for accounts allowlisted for general sign-in. The encrypted session must keep an
ID-token email with `email_verified=true`. Both addresses must use ASCII characters;
other addresses return `unsupported_email`. The server trims both addresses and
compares their ASCII lower-case forms. Request-body email claims are refused.
A matching account without an email or verification claim receives `sign_in_again`.
An unverified or different email receives `wrong_identity`. Identity checks happen
before pending-state and expiry checks, so another account learns no invitation state.

Fresh acceptance requires the session's `authTime` to be within the last 60 minutes,
including the exact 60-minute boundary. Older, missing or future sign-in times
return `sign_in_again`. A silent provider sign-in does not reset this time.
Session emails have a maximum of 320 characters. Sign-in rejects a session cookie
larger than 3,800 bytes, including its name and attributes, with a clear error and
clears both cookies rather than sending a cookie the browser may drop.

### Zitadel deployment requirements

In the silo's organisation, self-registration must be off. No external identity
provider may assert verified emails. Only trusted admins may set emails as verified;
this includes organisation owners, user managers and holders of management tokens.
These controls are part of the acceptance security requirements: a verified email
is trusted only because the deployment controls who can assert it.

The OIDC app must have `idTokenUserinfoAssertion=true` so Zitadel includes the
email claims in the checked ID token. `infra/dev-stack` reads the owner app and
the selected secondary app and stops setup with a clear message if this setting
is missing or not boolean true. That check writes no Zitadel setting. A trusted
admin must correct the app before setup can continue.

Emails are not unique in Zitadel. An email is not an account identifier.
Bound invitations also require the exact issuer and subject. An email-only invitation
allows only one account to complete acceptance.

### Current access and retries

A removed stream returns 403 `access_removed`, including a repeat of its saved join.
An earlier event binding another issuer or subject also prevents acceptance.
Active targets and owner-role invitations remain refused. The inviter must still be an active Owner or Admin by
member and ownership events; otherwise the response is 403 with
`{ status: refused, reason: inviter_authority_ended }`.
The final access check watches the joining member, inviter and ownership streams
for at most two seconds. Email-only acceptance also checks the latest member position.
Before starting that access check, email-only acceptance checks that the invitation
stream still has the position read at the start of the request. A renewal saved
before the account read finishes therefore cannot grant the old role or assistant
choice. A superseded invitation id returns 409 `unknown_invitation`; another
unexplained invitation change returns 409 `concurrent_change`. The person must
accept the current invitation. Later member changes are refused by the final
position check or the conditional append.
A changed watched stream or unavailable check returns
503 and saves no join in that attempt, except a confirmed inviter demotion or
removal returns 403 `inviter_authority_ended`. Email-only acceptance also reloads
the invitation after a changed-stream check: a saved join returns its receipt,
and another account's binding returns 409 `wrong_identity`. An unavailable recheck stays 503.
Expiry is checked again after the final access check.

There is an accepted small risk between that last check and append: the inviter
can lose authority in that window. Email-only acceptance rejects any member-stream
change at append, including an inviter demotion or removal. An ownership change
can still happen between the final check and append. Bound acceptance checks only
the joining member at append. Each command still writes one event to one stream.

For an admission that has not been removed, an exact saved-command retry returns
its original receipt before checking expiry, email claims or the inviter again. It never restores membership after removal.
Changed display-name or invitation arguments refuse reuse of the command id.
A lost append reply can return 503 even though the join was stored; repeat the
same command to find the saved result.

## Change a Member or Admin role

`POST /api/members/:memberId/role` accepts only `{ commandId, expectedSequence,
newRole: "member" | "admin" }`, within 1 KiB. It requires an organisation session,
the exact configured Origin, and current Owner/Admin access in events and OpenFGA.
The target must be active and must not be an Owner. Self-demotion is allowed.
The server supplies `previousRole` and `changedBy`. It reads history before its
two-second access check, then conditionally appends one `member.role_changed`.
An exact retry returns the same receipt. Changed arguments under that id return 409.

`GET /api/members/:memberId/changes/:commandId` returns the original `recorded`
receipt with command/event ids, type, sequence, time, member id and new role.
`projection.content` and `projection.iam` separately say `applying` or `current`.
A Member can read only their own original self-demotion receipt, including while
IAM catches up. Removed members cannot read status. A missing result returns 404
with `status: not_found`; the original request might still arrive.

If an appointment races the role append, ownership takes precedence. Both
projections keep running. Status reports `effect: none_target_became_owner`
while the target is an Owner, or when they were already an Owner at that append.
Other role results report `effect: role_changed`. Status reads append nothing.
Status reports IAM as `current` only after both the role and the competing appointment
have applied receipts, whether the appointment was saved before or after the role.
Permission jobs wait for earlier relevant changes on the member and ownership streams
before applying a role or appointment. Different delivery orders give the same state as replay.
Owner-role values and removal of an Owner remain rejected by both projections.
Step-down uses the ownership API and requires another currently active owner.

## Invitation command status and refusal history

`GET /api/invitations/:memberId/command-changes/:commandId` reads the creator's original
invitation command from events. Id bounds, session, exact organisation and
OpenFGA checks follow the invitation contract above. Reads use `no-store` and
append nothing. Another creator's command returns 404. A still-active creator
who lost admin access gets a minimal receipt; removed people get 403.

A saved invitation returns `status: recorded`, `commandId`, `changeId`, `type`,
`sequence` and `recordedAt`. An Owner/Admin creator also gets `result` with the
original receipt, email, role, assistant choice, `delivery: link_only` and a link
at `/join/:memberId/:invitationId`. The link grants no access; the join page is
not implemented yet. `projection.content` is `current|applying`, while
`iam: not_required` means creating an invitation grants no access.
Exact create retries return the original receipt even after acceptance.
Changed arguments return `command_id_reused` and append nothing.

A matching refusal returns `status: refused`, its event reference, time and safe
reason. A saved invitation always takes precedence. A missing result returns
404 with `status: not_found` and `commandId`; an earlier request may still arrive.
The older invitation status route retains its receipt shape and only returns
commands created by the same human caller.

Trusted create and acceptance refusals can save `member.command_refused` on
`memberaudit-<memberId>`. Successful commands save only their business event.
Records contain safe ids, an operation, a bounded reason and a SHA-256 digest
(a fixed-length value calculated from the request). The event key includes the
person, operation, target, reason and UTC day. Concurrent attempts and different
command ids therefore leave at most one such record per day. Only a SHA-256 digest
of the first attempt's command id is retained; later ids may have no status result. Status reads
compare the digest of the supplied id. Raw command ids are excluded from refusal
data because their allowed characters can still spell a secret or a person's name.
Refusal history stops at 10,000 events and two seconds.

Eligible refusal replies include `recorded: true|false`. Audit errors preserve
the original 403 or 409 with `recorded: false`. Invalid sessions, Origin, ids,
foreign organisations and changed saved-command arguments create no audit record.
Wrong-account records use a digest of silo, issuer and subject for the daily limit.
They expose neither that account's email, name nor subject.

`GET /api/org/history` exposes only safe member/invitation ids, operation, role,
allowlisted reason and event time to an Owner/Admin in the exact organisation.
Every audit response uses `Cache-Control: no-store`, including refused and
unavailable responses. Access is checked after the database read, so an admin
removed during that read receives no history. The existing audit worker and rebuild restore these records without granting
access or contacting outside services. Invitation lists, intended-person reads,
invitation read-table rebuilds and acceptance-command status remain follow-up work.

## Reviewed member removal

POST `/api/members/:memberId/remove` accepts `commandId`, `expectedSequence` and
`reviewRevision` from the departure GET. It requires current Owner/Admin access
and the same Origin. Incomplete reviews, changed revisions and owner targets
return 409. An owner must step down first.

One conditional append saves `member.removed` on the target member's stream.
That stream also records ownership confirmation, so competing requests cannot
save at the same reviewed member position. The server compares the reviewed
inventory revision and rechecks its category positions and the target's retained
computer and history positions before saving. Other members' chat messages and
chat table updates do not block the append. Pending history events for the target
still refuse removal. The inventory check and append
are separate operations; the target member position is checked atomically.
History and inventory reads finish before the two-second access check begins.

The receipt includes the original ids, member, sequence, time, reviewed revision,
`removedAt` and `access: revoked`. GET `/api/members/:memberId/changes/:commandId`
adds separate content and IAM progress. Revoked access does not wait for either.
An exact retry returns the original receipt; changed arguments return
`command_id_reused`. Status reads save nothing. Removed callers receive 403,
including for status. An Admin who removes themselves and loses the reply
learns the result from that 403. Cleanup status remains unavailable.

The dispatcher reacts to reviewed removals by removing current group memberships,
revoking direct and personal-assistant grants, and deactivating personal assistants.
It discovers resources when it runs, including grants added after the review.
It requires the inventory index to be current, then reads exact resource streams.
Missing or oversized inventory and failed writes leave the job for retry.
Old removals without `reviewRevision` cause no cleanup writes.
Personal computers are found through their assistants' exact streams. Idle ready computers
are suspended; open turns and starting computers leave cleanup unfinished for retry.
Lost personal computers cannot be reclaimed after their owner leaves.
Group grants, shared assistants and computers, connections and other members are untouched.
The worker records `member.departure_cleanup_completed` on `memberaudit-<memberId>`
after confirming saved changes and the group/grant OpenFGA receipts. Its `sections`
hold at most 100 saved event ids each for `groups`, `grants`, `assistant` and `computer`.
Earlier attempts' results are included. `removalId` names the saved removal.
This record changes no access. API cleanup status remains for the next change.

## Access and departure inventory

Owner/Admin GETs `/api/members/:memberId/access` and
`/api/members/:memberId/departure` read grant, group and assistant history through
indexed stream names. The index must be current for each recorded category and
have a completed-backfill marker. Creating an empty index during an upgrade does
not add that marker. A full member replay is required before reviews can be complete.
Each saved history read stops at ten seconds or 10,000 records.

Retained history uses bounded indexed creation and participation links for the
target and requires their conversation-worker receipts. The review compares
saved stream counts and participation positions with event-store metadata. A
new stream or participation change that cannot be checked makes the result
incomplete. Unrelated read receipts never cause a global history scan or a 503
because of their volume. The final removal check reads no conversation history
and does not aggregate the whole index.

Reviews stop at 100 groups, 100 grant streams, 100 assistants and 500 distinct
expanded people. Overlap counts once. Overflow reports `complete: false` and
`inventory_limits`; behind indexing reports `inventory_index`. Both block removal.
Removed memberships and revoked grants remain incomplete until their IAM receipts
arrive, even when no visible access rows remain. Ordinary projected chat messages
do not change the review revision.

Routine and connection history reports `absent_on_version` only after a complete
check. Known unsupported records report `unsupported_history`; incomplete reads
report `unavailable`. These states never stand in for an exact zero count.

## Tool access explanations

`GET /api/org/integrations/:serverId/access/explanation` requires strict query
fields `requesterId`, `assistantId` and `toolName`. Members can read only their
own requester context. Reading another person requires current Owner/Admin access.
The assistant must belong to that person's current personal or group context.
Foreign and unknown contexts receive 403. Before reading tool rules, the server
checks that the viewer is a current Owner/Admin or has a checked, saved requester
grant for the server. Inaccessible and unknown servers and tools all return
403 with only `{status: "refused"}`. Invalid input receives 400; failed reads
receive 503. Replies use `no-store`. A supplied Origin must match this website.

Replies contain safe direct, group and selected-assistant grant sources, checked
person/assistant permissions, `actsFor`, mode, review, catalogue dates and policy
positions. They contain no account identifiers, secrets, email or private content.
`reviewRevision` includes the inventory revision and exact policy positions.
A permitted explanation with a missing requester or assistant grant contains only
request ids, the check time, permission results and permission reasons. It omits
tool rules, catalogue dates, profile state, sources and review revisions.
An IAM outage returns `unavailable`, never a missing-grant reason for that check.
An incomplete inventory cannot establish grant absence. Such explanations return
503, including when new grants have reached OpenFGA before the member index.
A failed permission check without a server row also returns 503. Grant absence
checks group, assistant and grant inputs separately from retained chat and computer
history. Pending content tables do not refuse an otherwise checked explanation.
`profile: absent_on_version` means a complete history check found no profile
records on this version. Unsupported or incomplete history stays separate.
`not_required` means the saved account mode requires no account.

Gateway publication acknowledgement is not available yet. `publication` and
`availability` remain `unavailable`, with `complete: false`. An explanation is
never permission to dispatch a call or approve an Ask tool.

The existing admin member access reply adds `eligibility.toolExplanations` for
MCP server rows. It returns at most 50 assistant/tool explanations per row.
Overflow sets `toolExplanationTotal: null`, reports `tool_limits` and keeps the
reply incomplete. Missing definitions report `tool_policy` and a null total.
Reads stop at ten seconds; each exact MCP history stops at
10,000 records. Slow reads do not start a two-second write access check.
