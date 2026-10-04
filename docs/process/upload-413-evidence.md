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
Unknown dependency errors retain the sanitised 503 response.

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
