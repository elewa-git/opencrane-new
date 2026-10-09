# Member reads

Reads use `no-store`, verified session identity, current events and IAM; they append nothing.

| Read | Access and returned fields |
| --- | --- |
| `GET /api/members/:memberId` | Active Members get only `memberId`, `displayName`, `role` and false management flags. Inactive targets return 404. |
| Same route for Owner/Admin | Adds email, joined status, recorded `joinedAt`, groups with id/name/membership source, `memberSequence` and `ownershipSequence`. |
| `GET /api/members?q=&after=&limit=20` | Owner/Admin-only name/email search. Returns `rows`, `next`, `counts`, `checkedAt`, `projection.content` and `permissions.invite: false`. |

Only Owners get `manageOwnership: true` for the existing ownership API. Role/removal flags stay false.
`personalAssistant` and `rejoinedAt` return `{ status: unavailable }`. Access/departure reads are absent.
Existing screens stay unchanged.

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
pass. The planned email invitation flow will derive the member id at acceptance
from the silo, issuer, subject and admission number. The email-input route does
not create an invitation or grant membership. The existing `/members/join` command
still requires an invitation bound to a sign-in identity.

## Create and renew email invitations

`POST /api/invitations` records one `member.invited` event. Only a current Owner
or Admin, checked through events and OpenFGA, may create or renew it. The session
must belong to the configured organisation and silo. POST requires the exact Origin.
Its strict JSON body is `{ commandId, memberId, email, expectedSequence, role,
personalAssistant }`, at most 1 KiB. Both ids use 1–200 letters, digits,
underscores or hyphens. `expectedSequence` is a non-negative integer.

Email uses ASCII only, is trimmed and lower-cased, and has at most 254 characters.
`memberId` is `invitation-` followed by SHA-256 of JSON `[silo, normalisedEmail]`.
It identifies a pending invitation, not an admitted member. A different body id
returns 409 `identity_mismatch`. Role is `member|admin`; assistant choice is
required and is `provision|none`. The server supplies `invitedBy`, a stable
`invitationId` from the original command, and an expiry exactly seven days after
the event time. It records no issuer or subject and makes no Zitadel request.

An active member with that email returns 409 `already_member`, checked from events.
A removed stream returns 409 `access_removed`. Renewing a pending or expired
invitation uses the same email and stream, a new command id and its reviewed
position. A stale position returns `concurrent_change`; changed saved-command
arguments return `command_id_reused`. History reads finish before the two-second
caller, ownership and target check. The one append uses the reviewed position and
`historyChecked`; earlier events remain unchanged.

Success returns `{ status: appended, memberId, invitationId, sequence, createdAt,
expiresAt }`. An exact repeat returns that receipt without writing. A 503 or lost
reply can follow a stored append. `GET /api/invitations/:memberId/changes/:commandId`
finds its original receipt, or returns 404 `not_found`. This read requires current
Owner/Admin events and OpenFGA, checks access once and appends nothing. All replies
use `Cache-Control: no-store`. Invalid bodies return 400, missing sessions 401,
access refusals 403 and unavailable dependencies 503.

Acceptance is not built: `/members/join` returns `unbound_invitation` for these
records. No usable link or email is sent. Follow-up acceptance must derive the
admission id, bind issuer/subject on join and settle two accounts with the same
verified email through one conditional append. Lists and minimal receipts after
self-demotion remain follow-up work.

## Admission member ids

The server keeps a helper for selecting a member id from an authenticated issuer
and subject. The email route does not call it. Acceptance will use it after checking
the person's identity. Active or pending invitations keep their existing event-bound
ids. Otherwise SHA-256 of JSON `[silo, issuer, subject, admissionNumber]` selects
`admission-<hash>`, starting at zero and skipping removed member streams.
The helper tries at most 20 admissions. Conflicting identity events return
`identity_mismatch`; multiple active or pending bindings return `ambiguous`.
Twenty removed admissions return `admission_limit`.
The caller supplies a read deadline. More than 10,000 member events or any event
from another silo makes the search unavailable. It appends nothing.

The [rework receipt](../process/p4-3-pr2-rework.md) records the checks run for this route.
The complete fresh-install invitation journey is NOT RUN.

## Bound invitation acceptance

The existing `POST /members/join` remains available for invitations already bound
to an issuer and subject. Its strict body is `{ memberId, invitationId, commandId,
displayName }`, at most 1 KiB. It returns `Cache-Control: no-store`.
Acceptance records the invitation's `personalAssistant: provision|none` choice
in its one `member.joined` event. An older invitation without the field means
`provision`. The request body cannot change the choice. `none` skips personal
assistant creation and the computer claim that follows it; it still admits the member.
An exact retry, including after a lost reply, returns the saved join receipt.
It does not rerun assistant creation. Binding an email invitation to an account
at acceptance remains separate work.
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
These existing invitations also require the exact issuer and subject. A future
email-only invitation must allow only one account to complete acceptance.

### Current access and retries

A removed stream returns 403 `access_removed`, including a repeat of its saved join.
An earlier event binding another issuer or subject also prevents acceptance.
Active targets and owner-role invitations remain refused. The inviter must still be an active Owner or Admin by
member and ownership events; otherwise the response is 403 with
`{ status: refused, reason: inviter_authority_ended }`.
The final access check watches only the joining member, inviter and ownership
streams for at most two seconds. A changed stream or unavailable check returns
503 and saves no join in that attempt, except a confirmed inviter demotion or
removal returns 403 `inviter_authority_ended`. An unavailable recheck stays 503.
Expiry is checked again after the final access check.

There is an accepted small risk between that last check and append: the inviter
can lose authority in that window. The append is conditional only on the joining
member stream, so it cannot also reject a change to the inviter or ownership
stream. The current command keeps that single-stream write contract.

For an admission that has not been removed, an exact saved-command retry returns
its original receipt before checking expiry, email claims or the inviter again. It never restores membership after removal.
Changed display-name or invitation arguments refuse reuse of the command id.
A lost append reply can return 503 even though the join was stored; repeat the
same command to find the saved result.
