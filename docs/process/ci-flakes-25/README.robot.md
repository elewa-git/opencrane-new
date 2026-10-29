# Sender fixture evidence

Part of #576. Own checks on 29 October 2026. Base: `2ec78b82c2998d246f1d02b67b4361183b8bf4ba`.
Test-first commit: `0ae101237`. Fixture fix: `284467c8a`. Sources: faster-CI acceptance criteria,
engineering standard Tests and evidence, and routine design rows 10/12.

## Scope and cause

The sender fixture used to project `conversation.created` inside its append spy.
The session command had not finished its original two-second access check. Waiting
for the test's OpenFGA projection there could expire an otherwise valid command.
A controlled 2,100 ms monotonic-clock advance after projection reproduces that
failure, with 60,000 ms still left on the separate routine clock. The diagnostic
probe first failed at session preparation; the product returned its fixed
`Routine computer unavailable` error. The committed regression failed before the fix.

The fixture now wraps the real `prepareRoutineSession`, awaits its original result,
and applies the OpenFGA projection afterwards. It waits up to ten seconds for both
the exact applied receipt and posting permission before returning to
`prepareRoutineComputer`. The existing 30-second setup hook remains the overall
bound. The command, native preparation and remaining product checks still run.
No command is retried. The regression checks durable session/input records, a single
1,000-cent root, no reservations, one empty native thread and no native turn.

This proves one fixture ordering defect. It does not reconstruct the historical
23 failures or explain every current sender failure. An instrumented current-main
run also captured `Budget append unavailable` during root allowance preparation:
2.318 seconds for the root operation, 1.293 seconds inside the allowance call,
and 60 seconds left on the routine clock. Another root preparation took 2.254
seconds. A separate session failure took 1.118 seconds; its inner cause is unproved.
These are retained as failures. They are not called startBy expiry or repaired by
this fixture change. Further authority/budget investigation needs an astra follow-up;
this evidence alone does not prove a product bug.

## Environment and ownership

Linux shared development host, Node 22, one Vitest worker per command, all tests,
lint and typecheck under `nice -n 10`. `npm ci` ran in this worktree. NATS and
lychee use the supplied tool links. Tests use the supplied local `PG_TEST_URL` and
their own disposable NATS/OpenFGA services. The initial diagnostic load used that
supplied database. Subsequent concurrent projection load uses a separate throwaway PostgreSQL container, removed with its
volume afterwards. No owner stack or model call was used. No dependency, product
file, API/event field, security rule or authority test changed.
No credential or instruction value is included in this record.

Ownership notes and the pr5d prompt were checked before load. Neither secondary
stack slot was claimed at the initial check. Load pauses if pr5d starts live
qualification. The coordination note and raw local logs are retained outside Git.
Main advanced to `9ac1c6e3f` through #825 during the runs. This branch and its
measurements retain the recorded `2ec78b82c` base; no new-main qualification is
claimed here. Root READMEs, the memory work, expiry/reassignment files and CI
fixture registration remain unchanged. The guides in this folder document the fixture change.

## Commands and results

Every test invocation and required check is retained with its elapsed time in [the run table](runs.tsv).
Failing cases and their earliest known stage are retained in [the failure records](failures.jsonl).
Elapsed times come from Vitest's start/end timestamps. Interrupted runs and static
checks use log creation/modification times, rounded to a tenth of a second; those
measurements have about one second of uncertainty. Orchestrated runs also retain
separate wall-clock start/end receipts outside Git.

Raw local artefacts are named by the run id under `<evidence>/ci-flakes-25/`.
Only safe counts, test names and fixed stages are committed here.
The [temporary diagnostic patch](diagnostics.patch) applies to the base sender test;
it changes no product code. Its observations are limited to fixed stages, elapsed
milliseconds, remaining routine time and an allowlist of fixed error categories.
The final sender test SHA-256 is
`bc737ca112cb9f2b165167944311b03f07fbf8501633762bdb91eb0b5c65de6c`.

The base sender run uses the full sender file. Diagnostic selection uses the first
11 admission/access cases. The diagnostic full run adds observation wrappers only.
The projection probe and red/green runs select the single delayed-projection case.
The `green` selection and `sender-1` full-file attempt used a superseded fixture.
The latter was interrupted when Knip identified lost coverage of `routine-computer.ts`; it is PARTIAL.
The final implementation retains that real orchestration and passes Knip.
`green-final`, both `final-*` runs and the complete loaded attempts use the final
fixture whose hash is recorded above.

The final sender file runs twice, followed by five full one-worker repetitions
with bounded concurrent service-fixture load. The load uses five selected
routine-session cases first, followed by complete permission projection and routine permission files. At most one load command runs
beside one sender command. The five completed loaded attempts use a 1,200-second
external limit. Each load command is bounded at 180 seconds, with at most 12 per
sender attempt. A secondary stack claim
or the shared pause note stops the commands before live qualification. Each result
remains in the tables. A successful later run does not erase an earlier failure.
The first loaded attempt hit an external 900-second watchdog after 84 cases and
remains PARTIAL, with five cases untested. Cleanup had a further 20-second bound.
Its reported duration is that bound, not an invented completion time. Five full
loaded attempts follow with a 1,200-second external bound. Product deadlines and
Vitest's per-case and setup timeouts remain unchanged.

## Completed sender runs

Overall sender repeatability: FAIL. The 623 test executions span two ordinary runs
and five complete loaded repetitions: 577 passed and 46 failed. The new regression
passed in all seven. The separate interrupted loaded attempt remains PARTIAL:
50 passed, 34 failed and five not run. A later success does not clear a failure.

| Run | Result | Passed | Failed | Seconds | New regression |
| --- | --- | --- | --- | --- | --- |
| final-1 | FAIL | 84 | 5 | 701.749 | PASS |
| final-2 | FAIL | 86 | 3 | 546.738 | PASS |
| loaded-2 | FAIL | 74 | 15 | 882.608 | PASS |
| loaded-3 | FAIL | 85 | 4 | 675.309 | PASS |
| loaded-4 | FAIL | 80 | 9 | 654.331 | PASS |
| loaded-5 | FAIL | 84 | 5 | 753.249 | PASS |
| loaded-6 | FAIL | 84 | 5 | 679.999 | PASS |

All 58 concurrent load commands passed, with 2,526 case executions. Each command
and all earlier probes remain in the run table. No
product authority or budget defect is claimed fixed. The first observed allowance
failure and other unclassified starts remain an astra follow-up. The fixture cause
proved here is the delayed synchronous projection, not all sender preparation failures.

## Unrelated routine-session failures

Earlier supplied full-file main runs recorded 4, 38 and 6 routine-session failures.
Their preparation, activation and service waits remain unresolved. This task runs
five existing routine-session cases as load only. A passing selection does not
clear those earlier failures or qualify the other 377 cases. The complete
routine-session file is NOT RUN here and remains unchanged.

## Checks and remaining work

PASS: full lint, full typecheck, separate Knip, event catalogue (157 types), changelog lint,
focused code lint and 460 event security rules. The initial Knip failure came from
a superseded fixture that stopped calling the real computer preparation; that
implementation was replaced before the final runs. The complete sender matrix and
earlier failed attempts are recorded above and in the run table. No full root suite
was run.
Fresh-install live qualification: NOT RUN. Post-push CI: NOT RUN; the orchestrator
follows the draft PR. Automatic routine execution remains disabled.
