# Admin personal profile metadata

Part of #49. Date: 26 October 2026. Source: `304a0307fc30a065dde8e8e22b1696282bf3d37d`.
Base: `52ffc36d1`. Test-first commit: `59025da30`.
Prerequisites on the base: #709 `f858340914a3d411fc6e4cbf2d6703183787910d`;
shared models exports, #719 `7543fad8a4a74982a9d2e4aa7aac650247c57431`.

Current owners and admins can inspect one member's personal profile metadata.
The reply includes the profile and admin block revisions. It never reads credentials,
verifies an upstream identity or enables calls. History precedes one current access check.

Environment: a new worktree, `npm ci`, requested NATS/Lychee symlinks, disposable
NATS/OpenFGA fixtures and isolated databases on the supplied test PostgreSQL port 55432.
This was not a fresh product installation. Checks used `nice -n 10`, with one Vitest worker.
Lint was restarted with a 6 GiB heap after the first run stalled near its default limit.
No owner stack or daemon settings changed. External spending: 0 euro cents.

| Check | Result | Evidence |
| --- | --- | --- |
| Before implementation | FAIL (expected) | Both role tests returned 404; committed before the route. |
| Focused HTTP tests | PASS | 31 cases; roles, refusal ordering, privacy, lifecycle and no effects. |
| Final changed tests twice and own-read regressions | PASS | 31 admin tests twice; 86 existing route tests also passed twice. |
| Event security and exact risky-field matcher | PASS | 438 security tests; ten path/reply names pass the unchanged matcher and spelling rule. |
| Lint, typecheck, events, Knip and changelog | PASS | All stages pass; 154 event types agree. ESLint has zero errors and 25 existing warnings. |
| Admin disable HTTP/status, broker, OAuth and live credential use | NOT RUN | Outside this metadata read. |
| Full root suite and fresh-install journey | NOT RUN | Not requested. |

Logs use `/tmp/p3-8-pr7g-`: `red.log`, `tests1.log`, `tests2.log`, `tests3.log`,
`lint.log`, `typecheck.log`, `events.log`, `fields.log` and `changelog.log`.
