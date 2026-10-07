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

## Identity lookup

`POST /api/invitations/identity` is an Owner/Admin read with exact same-origin and organisation checks.
Its strict body is `{ email }`, at most 1 KiB; email length ≤254. It appends nothing and uses no write fence.
A match returns only `status: match`, `subject`, `displayName`, `email`, `memberId`, `memberSequence`,
`membership: none|pending|joined`, and `defaults: { role: member, personalAssistant: provision, expiresAfterDays: 7 }`.
Other results contain only `status`: not_found, unverified, inactive, not_human, ambiguous,
other_organisation, identity_mismatch or admission_limit. Timeouts/errors return 503/unavailable.
Active/pending event bindings keep older ids. Otherwise SHA-256 of JSON `[silo, issuer, subject, admissionNumber]`
selects `admission-<hash>`, starting at zero and skipping removed streams, with a limit of 20 admissions.
Earlier conflicting identity events refuse lookup. Multiple active/pending bindings return ambiguous.
The ten-second read stops at 10,000 member events; an incomplete search returns unavailable.
Zitadel uses exact two-row email search, checks organisation id/name and each user's owner,
and bounds responses to 64 KiB. Its only directory operations are search/get. Machine JWTs last one minute.

Live evidence, 7 October 2026, base `871c40d9`, slot 2 (existing, not fresh): PASS scoped
verified user search and mode 0600; PASS 403 for an ungranted organisation context without reading its body.
The foreign context id was a sentinel; access to another known existing organisation is NOT RUN.
The complete fresh-install journey is NOT RUN. No owner user, owner app or instance settings were changed.
