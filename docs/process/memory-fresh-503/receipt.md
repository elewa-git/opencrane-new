# First personal memory load

25 October 2026. Part of #94.
Product and test source: `6cd3f2bcb` on `work/memory-fresh-503`.
Base: `105071aaa08e82c638276886936c8538c007a9f3`.

## Cause and failing-first test

The route and key directories are already connected in the dev-stack entrypoint.
The workspace includes its new personal assistant in the scopes request.
Before this fix, scope discovery required the OpenFGA receipt for
`assistant.created` before checking whether that assistant had any note grants.
If the permissions worker had not applied that event, the whole request returned
HTTP 503, including the otherwise available personal scope.

The [regression test](../../../apps/server/test/memory-main.test.ts) starts
`apps/server/src/main.ts` on an empty event store with real NATS, PostgreSQL,
OpenFGA and the live memory worker. It supplies account events and a test session,
then leaves a new assistant's permission work pending. The scopes request includes
that assistant. No memory grant exists for its notes.

FAIL before the fix: the first scopes request returned HTTP 503
`memory_unavailable`. Temporary diagnostics identified the scopes step and
`Assistant permissions unavailable`. The temporary diagnostic logging was removed before the final test run.
The final failing-first run had one failed case and one passed safety case.
Test commits: `0eae1a99e` and `1e1c46d31`.

PASS after the fix: the request returns only personal memory, then saves and
searches one fact and reads it again after server restart. The safety case grants
note access and still requires HTTP 503 until the assistant permissions are applied.
The change reorders checks; it removes none of the checks required to return notes.
Key directories remain private, with mode 0700. No dependency or event type changed.

The original report in [PR #685](https://github.com/elewa-git/opencrane-new/pull/685)
did not retain the underlying error. Its precise historical cause cannot be proven
from that record. A fresh browser run before this fix passed once permissions had
caught up. The test holds the assistant's permission work pending, so the failure repeats.

## Fresh browser installation

The worktree claimed secondary slot 1 through `infra/dev-stack/claim.sh`.
It started with `DEV_OWNER_BOOTSTRAP=0`, empty membership history, real SSO and
the stand-in model. The server used the ordinary dev-stack entrypoint. The owner
stack was not used. Native memory was off.

The temporary browser collector reused the sign-in and first-read steps from
PR #685, then used Remember a fact, Store, Search memory and browser reload.
The [original observations](observations.jsonl) retain every attempt.

- PASS: first Memory scopes request returned HTTP 200 at 05:58:13 UTC.
- FAIL: the first collector attempt timed out locating the Kind selector, before
  any save request. The continuation kept the default Fact kind on the same install.
- PASS: the browser saved “I prefer jasmine tea”; HTTP 200 returned revision 1.
- FAIL: the immediate search returned HTTP 503 while the memory projection was
  behind. The worker applied the fact at 06:00:05.528 UTC. This existing consistency
  refusal remains unchanged; the UI does not automatically retry that read.
- PASS: a read-only continuation found the fact by searching for “jasmine”, then
  found it again after browser reload. It did not repeat the save request.
- PASS: the [desktop picture](saved-memory-1280.png) was inspected and shows the
  saved fact in personal search results.

The broader memory journey remains PARTIAL. Correction, forgetting, lost-response
recovery, stopped-worker replay, governed MCP recall and native memory are NOT RUN
live here. Immediate search during projection lag is still a UI limitation.

## Local checks

All lint, typecheck and test commands use `nice -n 10`.
The service tests used a disposable PostgreSQL 17.6 container with `PG_TEST_URL`
set, together with their own NATS and OpenFGA fixtures.

- PASS: `npm ci` in this worktree; the requested NATS and Lychee tool links.
- PASS: full workspace `npm run typecheck`, including package and dev-stack checks.
- PASS: `npm run check:events`, with 153 matching event types.
- PASS: 687 tests across `memory-main.test.ts`, `memory.test.ts`,
  `memory-worker.test.ts`, `main.test.ts` and `libs/events/test/security-rules.test.ts`.
  The command used `npm test --` with those file paths and `--maxWorkers=2`.
  The unchanged 438-case security suite ran once in this set.
- PASS: the changed `memory-main.test.ts` ran again on its own with
  `--maxWorkers=1`; both cases passed. The final code therefore passed both runs.
- PASS: full `npm run lint`, including Knip, documentation, README, link, fixture,
  package licence and changelog checks. Typed code lint reported 25 existing
  function-length warnings and no errors; both dependency checks passed.
- NOT RUN: the full root test suite. The runs above cover the changed behaviour
  and the requested security suite.
- PASS: both fresh secondary installs were released with `down.sh --id 1`.
  The disposable PostgreSQL container and its volume were removed with `docker rm -f -v`.
