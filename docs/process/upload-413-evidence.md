# Oversize upload refusal evidence

Date: 4 October 2026. Issue [#117](https://github.com/elewa-git/opencrane-new/issues/117).
Source: `work/i117-upload-413`, based on main
`3a9062784f8776a9031ea828d7401d1e094ce7d6`, with the changes in this receipt's commit.
Environment: existing shared dev host, Node 22.23.3, dependencies installed with
`npm ci`; normal disposable service fixtures. This was not a fresh silo install.
No dev stack, host networking or separately managed daemon was changed.

## Regression and outcome

The first HTTP regression ran before the fix. It expected a 20 MiB + 1 byte upload
to return 413 and `{status:"refused", error:"File too large. Maximum size is 20 MiB."}`.
It failed because Fastify returned its generic parser error instead. The parser
already enforced 413; the upload helper's separate size check threw an untyped
`Error`, which the old route error lookup would instead classify as 503.

After the fix, the HTTP regression passes. Parser size errors and the upload
helper use the same files-local refusal kind and status. The existing service
test also checks the helper's typed 413 refusal. Access, reused keys and content
refusals use typed errors; the files routes no longer match error message text.
Inspection failures retain their cause internally and give a stable 415 message.
The initial implementation reported unknown dependency errors as 503. The review
fix below replaces that classification with a sanitised 500.

The rendered workspace tests pass for both an oversized selection refused by the
browser and an upload receiving HTTP 413. Both show “File too large. Maximum size
is 20 MiB.” The existing web behaviour needed no production change.

## Source checks

| Command | Expected | Observed | Result |
| --- | --- | --- | --- |
| `npm ci` | Install this worktree's locked dependencies | Completed | PASS |
| `npx vitest run apps/server/test/upload-refusals.test.ts --maxWorkers=2` before fix | Expose missing clear size response | 1 failed assertion on the response body | FAIL (expected red) |
| Same HTTP regression after fix | Clear 413 refusal | 1 test passed | PASS |
| `npm run lint` | Code, dependency, unused-code, docs, links and fixtures pass | Exit 0; existing code warnings only | PASS |
| `npm run typecheck` | All workspaces compile | Exit 0 | PASS |
| `npm run check:events` | Registry and catalogue agree | 85 event types agree | PASS |
| `npm run test -w apps/web -- --watch=false` | Workspace and transport feedback pass | 62 tests in 12 files passed | PASS |
| `npm run build -w apps/web` | Production web build succeeds | Exit 0; existing CSS budget and CommonJS warnings | PASS |
| `PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres npm test -- --maxWorkers=2` | Full root suite passes with real service fixtures | 1,385 passed, 15 skipped, 1 failed in 85 files; 1,059.94 s | FAIL |
| Isolated approval case, same PostgreSQL URL, `--maxWorkers=1` | Recheck the unrelated failed fixture | 1 passed, 21 not selected; 12.11 s | PASS |
| Full root command repeated with `--reporter=verbose` | Complete suite passes, retaining the same URL and worker cap | 1,385 passed, 15 skipped, 1 failed; 784.98 s | FAIL |
| Isolated live-view case, same PostgreSQL URL, `--maxWorkers=1` | Recheck the second unrelated failure | 1 passed, 12 not selected; 8.18 s | PASS |
| Full root command with `--no-file-parallelism --reporter=verbose` | Complete suite passes without concurrent fixture files, same URL and `--maxWorkers=2` | 1,384 passed, 15 skipped, 2 failed in 85 files; 1,786.05 s | FAIL |

Before the root suite, `cut -d. -f1 /proc/loadavg` returned **15**, below the owner's
threshold of 16. Before the full repeat it returned **7**, and before the sequential
run it returned **5**. No waiting was needed.

The first full run failed in `refuses fence approval with zero upstream effects`
because `startGateway` threw `Gateway stopped` during fixture construction, before
the approval assertion or any upload request. That exact case passed in an
isolated repeat. No approval or gateway source was changed.

The second full run passed that approval case but failed the initial access check
in `refuses access when its previously checked authority history disappears`:
expected 200, observed 403 at `apps/server/test/live-view.test.ts:365`. That case
also passed in isolation. Live-view code does not call the changed files helpers.
The final full run uses sequential files to reduce fixture contention; no test is
filtered out and the races within each test still run. No live-view source,
fixture, timeout or assertion was changed.

The sequential run also reported a 40-second timeout in the unchanged gateway
test `does not dispatch a running decision: revocation during a history read within the freshness budget`
at `libs/models/test/gateway.test.ts:221`.
It also reported `Gateway stopped` while constructing the fixture for
`keeps forged JWT failures distinct from a caller-selected request through ingestion and replay`.
Both tests passed in the earlier full runs. The root gate remains **FAIL**; this
branch is not source ready and must not land until the gate passes. The upload
fix does not extend into gateway or live-view changes.

## Qualification limits

Fresh-install browser upload qualification is **NOT RUN**: this task forbids
touching a stack. Source checks and disposable fixtures do not qualify that
journey. Independent review and hosted CI remain for the orchestrator before
landing. The shared HTTP guard belongs to #121 and is outside this change.

## #117 branch qualification rerun

Date: 4 October 2026. Branch `work/i117-upload-413`, commit `d703e30`.
Environment: existing shared dev host and normal disposable test fixtures.
The PostgreSQL test URL was `postgres://postgres:test@127.0.0.1:55432/postgres`.
Before the root suite, `cut -d. -f1 /proc/loadavg` returned **11**, below the
required threshold of 16. No daemon, stack or host networking settings were
changed.

| Command / qualification | Observed | Result |
| --- | --- | --- |
| `PG_TEST_URL=… npx vitest run apps/server/test/upload.test.ts --maxWorkers=2` | 7 passed; 78.24 s | PASS |
| `PG_TEST_URL=… npm test -- --maxWorkers=2` | 1,385 passed, 15 skipped, 2 failed in 86 files; 1,346.38 s | FAIL |
| Isolated approvals case, `apps/server/test/approvals.test.ts -t 'opens one encrypted Ask card and forwards approved lossless bytes once across tabs, retries and restart' --maxWorkers=1` | 1 passed, 21 skipped; 20.92 s | PASS |
| Isolated OpenFGA case, `libs/authz/test/projection.test.ts -t 'cleans a rebuild store when the create response is lost at the HTTP boundary' --maxWorkers=1` | Failed again at its 5-second timeout; 1 failed, 10 skipped; 11.36 s | FAIL |

The focused upload tests pass. The full-suite approvals failure was a 503 in
the test `opens one encrypted Ask card and forwards approved lossless bytes
once across tabs, retries and restart`; it passed alone. The other full-suite
failure was the unchanged authorisation test `cleans a rebuild store when the
create response is lost at the HTTP boundary`. It timed out both in the full
suite and alone. This is the same five-second OpenFGA fixture timing issue
recorded under #136 in [wake-latency-evidence.md](wake-latency-evidence.md).
No source, fixture or timeout was changed. The root suite result remains
**FAIL** because of these unrelated failures.

## Review pass 2 blocker fixes

Date: 4 October 2026. Branch `work/i117-upload-413`, based on `58b4865`,
with the fixes in this receipt's commit. The owner authorised closing the
remaining pass 2 blockers before one focused verification. This receipt records
builder checks, not another independent review pass.

The focused tests were written before the production fixes. They reproduced
unexpected object-store `TypeError` responses of 503 during upload and download,
an oversized invalid scanner reply reported as 503, an empty helper upload
reported as a typed 415 instead of 400, and malformed command input escaping as
`ZodError`. Confirmed connection-refusal, timeout and service-unavailable cases
already passed; those assertions remain as guards against losing the typed 503.
A separate HTTP fixture also reproduced MinIO's SDK discarding a service's 503
status and throwing an ordinary retry error.

The final implementation marks confirmed outages at the storage/scanner boundary
and preserves unknown failures for the stable, sanitised 500 response. The
object-store transport marks HTTP 503 before the SDK can discard its status.
Request and command input share the typed input parser, and an empty upload
raises `invalid_request` with status 400 before content inspection. Scanner
callbacks and the changed integration request builders now have names and
readable steps. No dependency was added.

The service test command used
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres` and
`npx vitest run` with `--maxWorkers=2`, selecting `apps/server/test/upload.test.ts`,
`upload-refusals.test.ts`, `file-command-refusals.test.ts`,
`file-upload-failures.test.ts`, `file-storage-failures.test.ts` and
`file-scanner.test.ts` from that same directory.

| Command / qualification | Observed | Result |
| --- | --- | --- |
| Focused upload and files tests above | 20 tests passed in 6 files; 103.44 s | PASS |
| Files tests after fixture readability cleanup, same PostgreSQL URL | 13 tests passed in 5 files; 20.66 s | PASS |
| Upload integration rerun after naming gate callbacks, same PostgreSQL URL | 7 tests passed; 79.90 s | PASS |
| `npm run lint` | Code, dependencies, unused code, docs, links and fixtures pass | PASS |
| `npm run test -w apps/web -- --watch=false` | 62 tests passed in 12 files | PASS |
| `npm run typecheck` | All workspaces compile after correcting test timer options | PASS |
| `npm run check:events` | 85 event types agree | PASS |
| Full root suite | Skipped at the owner's request; CI owns the next full run | NOT RUN |
| Fresh-install browser journey | No stack was claimed or changed | NOT RUN |

Normal disposable NATS, PostgreSQL, OpenFGA, MinIO, ClamAV and computer fixtures
ran. No second daemon, owner stack or host networking settings were changed.
The earlier full-suite failures above remain historical failures; the focused
passes do not turn the full root gate green. Hosted CI and the owner's focused
verification remain outstanding before landing.
