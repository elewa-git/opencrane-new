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
