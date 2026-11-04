# Packaged Stop and reconnect checks

Part of #97. Built from `a0a53a050` on `work/p4-15-pr5n`.

The shipped runner calls the production Stop handler after saved Correct and Forget
invalidation. The same assertions run in server tests. They check exact delivery,
changed-event and identity refusal, missing connections, reconnect, failed sends,
retry and cold reads. A saved replacement turn and an unrelated loaded context keep
their state and event positions. The package fixture mounts only temporary credentials
and loads helpers from the image.

Successful `stopReconnect` assertions report PARTIAL / complete=false. All other
statuses stay unchanged. Native Stop/reconnect, browser clearance, persistence and
both qualifications remain NOT RUN. Admission stays disabled; queued 5i3 stays held.
No computer, production Stop, authority, security-rule or image files change.
No new event/API fields, dependency, stack or paid model call is introduced.

## Own validation

- PASS: test-only commit `2c01ea66b` preceded implementation. Four runner cases
  failed while Stop/reconnect was NOT RUN. The two positive server cases also fail
  with the original helper and pass with the final helper restored.
- PASS: 80 server tests twice, including 29 new Stop cases and 51 existing
  invalidation cases. Bad results, frames and cold states refuse separately.
- PASS: 136 collector, runner and protected-result tests twice. These cover fixed
  errors, wrong-silo refusal before writes, saved PARTIAL results and refusal of a
  PASS claim with an incomplete Stop check.
- PASS: six package-image tests twice with the final helper. Both Correct and Forget
  run through image modules, with only fixture credentials mounted.
- PASS: six existing container cleanup cases. Timeout, stdout/stderr overflow,
  collector SIGTERM/SIGKILL, retry exclusion and leftover children remain covered.
- PASS: 460 unchanged event security-rule tests once.
- PASS: full lint, including Knip, dependency, documentation, link, fixture,
  licence and changelog checks. There are 35 existing warnings and no errors.
- PASS: workspace and infrastructure typechecks. The server and collector were
  rechecked after fixing new test types. The collector also uses its explicit project.
- PASS: event catalogue, with 158 matching event types, and diff whitespace.

Tests, lint, typechecks and image builds ran under `nice -n 10`. Tests used one
worker. The final changed-test runs and security test used the supplied fixture
`PG_TEST_URL`. No full root suite ran.
The collector's Vitest configuration was used for its tests. Server and event tests
used the root configuration with explicit file names. GitHub CI is checked on the
pushed commit and reported with the draft pull request.
