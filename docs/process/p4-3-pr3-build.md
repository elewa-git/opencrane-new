# Invitation acceptance checks

Built on 8 October 2026 from main `7f3e9b90`, using Node 22.23.3.
This is the first of two changes for the invitation command work in
[issue 85](https://github.com/elewa-git/opencrane-new/issues/85).
The [7 October default](https://github.com/elewa-git/opencrane-new/issues/85#issuecomment-6039484708)
requires email confirmation at acceptance and no directory credential.

## What this change provides

Existing bound invitations now require a verified sign-in email and the exact
organisation. Acceptance checks the inviter's current member and ownership
events immediately before saving a join. Removed streams and earlier bindings
to another identity cannot be reused. Exact saved-command retries remain usable
and never restore membership. The response reveals no invitation details to the
wrong account.

The full email invitation flow needs more than about 600 changed lines once
creation, acceptance, projections, assistant choice and guard tests are included.
This independently usable first change prepares the session claims and protects
the existing join route. The second change will add email invitation creation
and renewal, admission selection at acceptance and assistant choice. Invitation
list/status reads remain later work. No Zitadel calls were made.

## Local evidence

The initial selected run failed before implementation: the session did not keep
email claims, and the new acceptance assertions did not pass.
The guard tests use real disposable NATS. Other selected ownership and bootstrap
tests use their existing disposable PostgreSQL and OpenFGA fixtures. Sign-in
claims are checked with the signed loopback OIDC provider and a cookie round trip.

All 18 temporary code changes caused assertion failures in the matching tests:
email verification, email matching, forwarded account, earlier identity binding,
removed stream, active target, owner role, current inviter role, final access
check, expiry, Origin, exact organisation, stored member id, strict body, body
size, saved reply, signed verification claim and signed email claim.
Each temporary change was restored. The tests check replies and stored outcomes.
The lost-reply test saves a join, loses its reply, reconnects NATS and repeats
its command without saving a second join.

| Check | Result |
| --- | --- |
| Clean `npm ci` and both requested tool links | PASS |
| All 18 mutation probes | PASS |
| First selected run, five files | PASS: 123 passed, one skipped |
| Second selected run, five files | PASS: 123 passed, one skipped |
| `lint`, `typecheck` | PASS |
| `check:events` | PASS: 98 event types agree |
| Knip and `lint:changelog` | PASS |
| PostgreSQL 17 join/rebuild test requiring `PG_TEST_URL` | NOT RUN |
| Full root suite, web build/tests | NOT RUN |
| Independent review, hosted CI, fresh-install journey | NOT RUN |

Safe local logs are under `/tmp/p4-3-*.log` on the builder host. The skipped join
projection test is reported separately; passing local tests do not qualify a
fresh installation or the remaining email invitation flow.
