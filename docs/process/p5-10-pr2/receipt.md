# Two-silo member-list reconnect checks

Part of [#15](https://github.com/elewa-git/opencrane-new/issues/15).
This is source proof with disposable services, not packaged-install acceptance.

## Scope

Two silos use different NATS servers, PostgreSQL databases and OpenFGA stores.
They have different configured organisations and browser Origins. They deliberately
share the test cookie secret, issuer, subjects, member ids and resume
positions. The test uses real server child processes and WebSocket connections.
At most three server children are live together. One test worker runs under `nice -n 10`.

A reads history, stops its first server and resumes on its second server. Exact
member rows show ordered local history and live delivery. An unrelated chat leaves
the connection open. B refuses A's cookie before subscription, including after a
projection repair. The cookie is bound to its redirect URI and receives 401.
Missing/wrong Origins and locally encrypted sessions for the other organisation
receive 403.
A local B cookie with A's numeric cursor can read only B's own changes. After
repair, the old generation receives only a reset and closes with 1013. Reloading
B returns exactly its four changes, with B's own email, name, role and status.

A's surviving server closes during an actual OpenFGA pause. A pending read can
close with 1011; the access poll can close with 1013. Both must deliver no more
records. The original outage test now checks the same two existing close paths.
Once it recovers, a saved removal closes the existing connection and refuses a new subscription
while PostgreSQL and OpenFGA still report admin access.

The checker was tested first: it accepted an old reset generation and the new
test failed. The fix checks both generation and reset position. Negative checks
also reject one protected record around refusal/reset and incorrect close codes.
Startup, shutdown, setup and cleanup errors discard injected sensitive canaries;
cleanup still releases later resources. Annotations contain only fixture ids,
ports, positions, generations and close codes. Full rows stay in test memory.

## Checks

All checks run under `nice -n 10`. Test commands use one worker and a
`PG_TEST_URL` pointing to an owned throwaway PostgreSQL 17.6 container.

- PASS — 28 cases across `realtime-replicas*.test.ts`, twice. This includes the
  five original scenarios. The final full-reply isolation assertion passed twice;
  an extra isolation-only run passed all three cases after the second batch.
- PASS — all 438 cases in `libs/events/test/security-rules.test.ts`, once.
- PASS — root typecheck, plus a final server typecheck after the test changes.
- PASS — `npm run check:events`: 154 event types agree.
- PASS — final targeted ESLint and `git diff --check`.
- PASS — full `npm run lint`, including Knip and `npm run lint:changelog`.
  ESLint reported no errors; its 25 warnings concern unchanged production files.
- PASS — disposable service cleanup; the owned PostgreSQL container was removed
  with `docker rm -f -v`.

No full root test suite or live stack was started.

## Remaining qualification

- NOT RUN — gateway/live-view input and network refusal journeys.
- NOT RUN — budget-writer failure and charge reconciliation.
- NOT RUN — scanner consumers.
- NOT RUN — browser journeys at 1280 and 390 pixels.
- NOT RUN — packaged replica placement and fresh-install qualification.
- NOT RUN — stack/model calls and the full root test suite.

No production access deadline, event/API field, authentication scheme, chart or
package source changed. The exact `RISKY_FIELD_NAME` check is unchanged, as are the
authority and authority-volume tests. The Phase 3/4 refusal contracts still apply.
