# Personal recall through the real backend

5 November 2026. Part of #97. Branch `work/p4-15-pr4m5`.

## Source and scope

Base: #878, `67e1cff993b82410b52a8a04da249ba84c44ce16`.
Prerequisites: #870, `34da39127b23e26e2457b57c68957769efc303fa`, and
PR #871, `6031183ebb29f8023edf914adb04913a58088884`.
Server preparation is #875, `d3205b75a6eafe9bd1974e4be889f6058efe91cd`.

This split joins existing production code in a test. It changes no production code,
event, API field, dependency, admission setting or protected authority/security test.
The computer change extends only its existing test fixture with a gateway address,
a grant map and calls from the scripted native peer.

The native peer retains the endpoint and caller established by its authenticated
launch and discovery. The server sender, assembler, bridge, loader, proxy, gateway,
decision service and memory backend are real. Encrypted facts are saved as events and
projected into disposable PostgreSQL. NATS and OpenFGA are also disposable services.
Saved admission and deployment observations are supplied by fixtures. This is not a
fresh installation, a paid model call or proof that a deployment is qualified.

## Behaviour checked

- A stored own-person fact, absent from initial input, reaches the admitted native
  thread as the real structured recall result. Discovery makes no backend call.
- Before the backend sends any successful result bytes, its saved evidence names the
  returned reference and contains the measured reply size. Conversation events contain
  no fact text.
- Holding the evidence append returns no result. Denied and unknown append outcomes
  return no facts. A saved unknown append survives a cold evidence read, without
  returning the result. Repeating a saved call returns no facts and appends no new load.
- Poisoned requester, session, turn and memory-context headers cannot change the
  server-signed requester, thread, scope or turn. Caller credentials stay local.
- Whole pages stay below 16 KiB. Four replies retain their measured total below 64 KiB;
  the fifth is refused. Thirty-two initial references leave no room for a new one.
  Existing fold tests independently check the exact cumulative byte boundary.
- Two sessions belonging to the same person keep separate catalogues and reference
  accounting. Removing one local caller leaves the other's backend recall usable.

Discovery identity mutations, withdrawal races, cancellation, lost receipts and
membership-error precedence retain their existing preparation and computer tests.
They are not all repeated through this new backend fixture. No new qualification
claim follows from those complementary checks.

## Own checks

- PASS: test-first commit `b534d50f8`. Native dispatch completed, then the stored-fact
  assertion failed because the original discovery fixture had no forwarding grant.
- PASS: 737 selected tests, including 460 unchanged security-rule cases.
- PASS: all seven new backend checks twice on the final code; the computer recall
  runner and discovery suites also passed twice.
- FAIL: the second broader run passed 130 of 131 tests. The unchanged replacement
  test in `memory-delivery.test.ts` failed in setup: its initial native turn did not
  start within ten seconds. Its replacement assertions never ran. The first full
  selected run passed this test. This failure is retained, not waived as a known flake.
- PASS: an isolated diagnostic rerun of that replacement case. The broader failure
  remains FAIL; this does not make the branch source ready.
- PASS: clean full `npm run typecheck`, `check:events` and `lint:changelog`.
- PASS: every lint stage, including Knip. Documentation and later stages passed after
  fixing a receipt formatting error. Final focused code lint also passed.
- NOT RUN: full root suite, development stack, paid calls and fresh-install qualification.

Commands use `nice -n 10`; tests use one worker and no file parallelism.
`PG_TEST_URL` points to a task-owned PostgreSQL container on a dynamically assigned
loopback port. The owner stack is untouched. The container and volume are removed
after the checks. Global admission remains disabled.
