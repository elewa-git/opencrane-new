# Decision dependency failures

Part of #576. Own checks on 29 October 2026.

## Change and environment

Base: `8b93ce3c155382bc681622e8e62a948216400f16`, fetched from `origin/main`.
The clean worktree ran `npm ci` and reused the installed NATS, Lychee and gateway
binaries through local symlinks. Tests used disposable NATS and OpenFGA services.
Load runs used a throwaway PostgreSQL 17.6 container. Required focused checks used
the supplied PostgreSQL test service. Every test, lint and typecheck command ran
under `nice -n 10`. Node was 22.23.3. This was a development checkout, not a fresh installation.

## Reproduction and failing tests

Temporary local logging recorded the decision stage, reason and exception.
It was removed before the fix was committed.

The main load run reproduced the original failure at `decision-cost.test.ts:708`:
`access_and_budget`, `event_store_unavailable`, a NATS `TimeoutError`, and HTTP 403
with `Request refused or decision service unavailable`. It took 3,346 ms.
Another test process was running the two complete decision files alongside it.
Both Vitest workers loaded the original decision code before the fix was edited.
Editing began before the long MCP baseline command finished. Its later replay
subprocesses may therefore have read edited files; their unrelated failures are
observations, not a separate clean-main comparison. The original loaded decision
code produced the traced 403 above. All 20 final repetitions use the settled fix.
The previous [main comparison](https://github.com/elewa-git/opencrane-new/pull/800#issuecomment-6485629347)
also identified an unavailable IAM receipt check reported as a missing receipt.

Four later probes used a separate checkout of the same main commit with its own
`npm ci`. Only temporary logging changed there. Two selected the large-cache case
and passed (one case each, 27 skipped). Two ran the whole decision-cost file and
passed all 28 cases each. They overlapped the final load pair, keeping the total
at four workers. These probes did not reproduce the intermittent timeout again.
Their extra logging therefore cannot identify which individual NATS operation
failed in the earlier `access_and_budget` stage. The original timeout is confirmed;
its exact stream or budget operation remains unresolved. The separate checkout
and all its temporary logging were removed.

Test-only commit `d33eab665` preceded the production fix. Eight new HTTP cases
failed with 403 where 503 was required: history, access and grant reads, a budget
write, and failed membership, receipt and resource checks plus a slow membership
check. The existing diagnostic case passed. The first draft of these tests omitted
`stream: true`; that invalid request was corrected before this test-only commit.
The budget fixture was later corrected to prove its failed write was not sent
before requiring a successful retry. Unknown writes still block recovery.

An initial baseline launch lacked the gateway binary. It was stopped and the
binary was linked before restarting. That launch is a setup failure, not test evidence.

## Own checks

Production source: `4241f4acaeb21d0003589e7bd77294722d3e2c7b`.
The final receipt-only commit does not change that tested code.

| Check | Result | Detail |
| --- | --- | --- |
| Full typecheck | PASS | All workspaces, package and dev-stack checks |
| Event catalogue | PASS | 157 event types agree |
| Separate Knip | PASS | No unused or unlisted dependency remains |
| Changelog | PASS | Branch fragment accepted |
| Final changed-file lint | PASS | Two existing function-length warnings; no errors |
| Final regression file, run 1 | PASS | All 9 cases |
| Final regression file, run 2 | PASS | All 9 cases |
| First broader focused run | FAIL | 499 passed, 2 failed: cold-history timeout and cache-volume 503 |
| Second changed-suite run | FAIL | 36 passed, 1 failed: cache-volume 503 |
| Unchanged authority suites | PASS | Both files passed in the first broader run |
| Security rules | PASS | All 460 cases, once in the first broader run |
| Full lint | PASS | Code, dependencies, Knip, docs, links, licences and changelog |

The first full lint attempt stopped with an ESLint internal exception after files
changed while it ran. Focused lint then found a file-length limit and an unsafe test
matcher. The response helper was extracted and the matcher replaced with a strict
schema. Full lint then passed against the settled code.
The first separate Knip attempt found a test import from an unlisted dependency.
The test now obtains a real timeout through the installed event-store interface;
no dependency was added.

The two changed-suite commands used the supplied PostgreSQL test URL. The first
also included both unchanged authority files and the security rules. Both ran under
`nice -n 10`. After the response helper was extracted, the final regression file
passed twice more. Cold-history tests now require exactly 503; the allowed-call
assertions still require exactly 200 and keep the two-second limit.

The baseline pair was FAIL: the complete two-file run had 204 passing and 4 failing
cases. These were cold-history timeout, cache-volume 403, expired-approval replay,
and the saved-start ordering check. The parallel decision-cost-only run had 27
passing cases and the cache-volume 403. The specific `gateway_502` case passed in
the complete baseline run; the earlier main evidence and the new HTTP proxy tests
cover the IAM receipt failure separately.

## Full-file load runs

Each run includes every case in `mcp-dispatch.test.ts` and `decision-cost.test.ts`,
with a total limit of four Vitest workers. Runs 1–2 use two workers per command;
runs 3–20 use four parallel commands with one worker each. The last two commands
also run alongside each other. Every command uses `nice -n 10` and the throwaway
PostgreSQL service. No case is selected out and no assertion is relaxed.
Safe local logs and JSON reports are in `/tmp/ci-flakes-24/` as `load-NN.log` and
`load-NN.json`; `load-results.json` retains command exits and durations.

Completed: **20/20**. Passing runs: **2/20**. Tests: **4107 passed, 53 failed, 0 skipped**.
A later pass does not erase an earlier failure. The overall load qualification remains **FAIL**.

| Run | Result | Passed | Failed | Skipped | Large-cache case | `gateway_502` |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | FAIL | 206 | 2 | 0 | FAIL (503) | PASS |
| 2 | FAIL | 206 | 2 | 0 | PASS | PASS |
| 3 | FAIL | 201 | 7 | 0 | FAIL (503) | PASS |
| 4 | FAIL | 204 | 4 | 0 | PASS | PASS |
| 5 | FAIL | 201 | 7 | 0 | FAIL (503) | PASS |
| 6 | FAIL | 201 | 7 | 0 | FAIL (503) | PASS |
| 7 | FAIL | 205 | 3 | 0 | FAIL (503) | PASS |
| 8 | FAIL | 207 | 1 | 0 | FAIL (503) | PASS |
| 9 | FAIL | 207 | 1 | 0 | FAIL (503) | PASS |
| 10 | FAIL | 207 | 1 | 0 | FAIL (503) | PASS |
| 11 | FAIL | 204 | 4 | 0 | PASS | PASS |
| 12 | FAIL | 205 | 3 | 0 | PASS | PASS |
| 13 | FAIL | 206 | 2 | 0 | PASS | PASS |
| 14 | PASS | 208 | 0 | 0 | PASS | PASS |
| 15 | PASS | 208 | 0 | 0 | PASS | PASS |
| 16 | FAIL | 206 | 2 | 0 | FAIL (503) | PASS |
| 17 | FAIL | 205 | 3 | 0 | FAIL (503) | PASS |
| 18 | FAIL | 206 | 2 | 0 | FAIL (503) | PASS |
| 19 | FAIL | 207 | 1 | 0 | PASS | PASS |
| 20 | FAIL | 207 | 1 | 0 | PASS | PASS |

### Every failed case

Repeated failures are grouped by the test name and observed error. Run numbers
identify every occurrence. These results remain failures.

| Test | Observed error | Runs |
| --- | --- | --- |
| lets a cold models process catch up and then admits using only the chat tail | TimeoutError: timeout | 1, 2, 6 |
| keeps 10,000 members on one model and eight models with 1,000 members cached in one process | AssertionError: {"error":"Decision service unavailable"}: expected 503 to be 200 // Object.is equality | 1, 3, 5, 6, 7, 8, 10, 16, 17, 18 |
| allows two concurrent calls on the same tool | AssertionError: {}: expected 403 to be 200 // Object.is equality | 2 |
| admits model and ordinary MCP calls from the same decision process | AssertionError: authentication failure: the token is invalid or malformed: Error(InvalidSignature): expected 401 to be 200 // Object.is equality | 3, 4 |
| refuses old approval after watch recovery: failed, retry false | TimeoutError: timeout | 3, 5, 6 |
| restores drift only through exact live publication: exact | Error: Command failed: npm run replay -- audit --verify | 3 |
| restores drift only through exact live publication: intent only | Error: fetch failed | 3 |
| restores drift only through exact live publication: unpublish | Error: fetch failed | 3 |
| restores drift only through exact live publication: restart before | Error: fetch failed | 3, 5, 12 |
| denies mutable servers without an operator-reviewed atomic revision contract | AssertionError: authentication failure: the token is invalid or malformed: Error(InvalidSignature): expected 401 to be 403 // Object.is equality | 4 |
| refuses a hosted image without recorded image admission | TypeError: fetch failed | 4, 5 |
| restores drift only through exact live publication: exact | Error: Command failed: npm run replay -- conversations --confirm-conversations-stopped | 4 |
| refuses old approval after watch recovery: failed, retry true | TimeoutError: timeout | 5 |
| restores drift only through exact live publication: duplicate after drift | Error: fetch failed | 5 |
| restores drift only through exact live publication: drift during final read | Error: Gateway delivery unavailable | 5 |
| checks zero-cost MCP spending stops for renewed token | TypeError: fetch failed | 6 |
| refuses old approval after watch recovery: stalled, retry true | Error: Catalogue watch stopped or timed out | 6 |
| restores drift only through exact live publication: exact | Error: expected 404 to be 200 // Object.is equality | 6 |
| refuses spoofed unacknowledged constants with 1 copies | Error: fetch failed | 6 |
| restores drift only through exact live publication: intent only | Error: expected 404 to be 200 // Object.is equality | 7 |
| guards published HTTPS tool calls: deadline | Error: expected +0 to be 1 // Object.is equality | 7 |
| keeps 10,000 members on one model and eight models with 1,000 members cached in one process | AssertionError: {"error":"Decision audit unavailable"}: expected 503 to be 200 // Object.is equality | 9 |
| keeps decision reads flat at 10, 100 and 500 turns and at 10 and 3,000 chat events | AssertionError: {"error":"Decision service unavailable"}: expected 503 to be 200 // Object.is equality | 11 |
| keeps a stopped free turn from model sends after recovery: refused MCP pass | AssertionError: {"error":"Decision service unavailable"}: expected 503 to be 200 // Object.is equality | 11 |
| restores drift only through exact live publication: restart after | Error: fetch failed | 11 |
| restores drift only through exact live publication: drift during final read | Error: fetch failed | 11 |
| refuses old approval after watch recovery: stalled, retry true | AssertionError: expected 401 to be 503 // Object.is equality | 12 |
| restores drift only through exact live publication: older generation | Error: Gateway delivery unavailable | 12 |
| restores drift only through exact live publication: expired | Error: Gateway delivery unavailable | 13 |
| keeps another server approval through memory reload | Error: fetch failed | 13 |
| holds recording upstream through failed and recaptures on worker replacement | Error: Catalogue watch stopped or timed out | 16, 17 |
| requires the latest team team revocation receipt while IAM still allows | AxiosError: timeout of 1000ms exceeded | 17 |
| refuses computer-assistant history restored below its summary without reserving more money | Error: Test timed out in 40000ms. | 18 |
| checks remote adapter evidence without resending: outage | Error: fetch failed | 19 |
| guards published HTTPS tool calls: wrong_name | AssertionError: {"error":"Decision service unavailable"}: expected 503 to be 200 // Object.is equality | 20 |

## Not run

The full root suite and fresh-install live qualification were NOT RUN.
CI is not awaited after opening the draft pull request.
