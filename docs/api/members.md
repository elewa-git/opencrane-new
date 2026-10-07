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
email after trimming and ignoring case. The organisation check must pass. The server
derives the member id at acceptance from the silo, issuer, subject and admission
number. These acceptance checks are planned for PR 3; this route does not create an
invitation or grant membership. The existing `/members/join` command still requires
an invitation bound to a sign-in identity.

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
