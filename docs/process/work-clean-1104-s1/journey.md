# Routine release refusal and fresh core journey

Date: 16 November 2026

Source head: `d13c4095f4d577e6fb0acb1307cbf36f5d201eb2`

## Reproduction and cause

PASS: Holding a competing PostgreSQL advisory lock past the unchanged one-second
acquisition limit reproduced the original `expected false to be true` failure at
`changeBeforeFinalRelease`. Commit `fdb8962d6` contains that failing reproduction.
The generic leadership error matched even though the final-release hook had not run.

The release test depended on a real one-second database leadership deadline that
could refuse dispatch before the budget change it intended to test. A fixed
`performance.now()` did not control that real database timer. This reproduces a
cause of the observed early refusal; the historical CI failure has no recorded
underlying error from which to assign its exact cause.

The release matrix now uses a controlled leadership check, including cancellation
and the supplied deadline. Each case must finish its injected change and observe
the actual final-release append result. Refused cases require `unavailable`; the
unrelated-budget case requires `appended`. Real events, PostgreSQL projections,
OpenFGA, budget checks and socket delivery remain in use. The successful case waits
for the existing native-execution signal before asserting execution.

A separate real-lock test requires acquisition-phase refusal before hand-off and
checks that no due or release event or turn was sent. A real query lasting beyond
the unchanged one-second probe limit cancels the lease and logs `Query read timeout`.
Structured error records retain recognised underlying messages, codes and phases,
excluding arbitrary text, SQL, addresses, stacks and adapter fields.

## Own checks

PASS: Ten consecutive whole-file runs on the source head above, with every test
command prefixed by `nice -n 10` and `PG_TEST_URL` selecting the shared disposable
test database. A separate busy Python CPU process ran in parallel for every run.
Each run used `npx vitest run apps/server/test/routine-handoff.test.ts --maxWorkers=2`.
The command loop stops on failure; no retry was configured. All 700 test executions passed.
Durations below include the command wrapper and test transformation.

| Run | Started (UTC) | Seconds | Result |
| --- | --- | --- | --- |
| 1 | 2026-11-16T10:25:23Z | 393 | PASS, 70/70 |
| 2 | 2026-11-16T10:31:56Z | 364 | PASS, 70/70 |
| 3 | 2026-11-16T10:38:00Z | 358 | PASS, 70/70 |
| 4 | 2026-11-16T10:43:58Z | 361 | PASS, 70/70 |
| 5 | 2026-11-16T10:49:59Z | 374 | PASS, 70/70 |
| 6 | 2026-11-16T10:56:13Z | 361 | PASS, 70/70 |
| 7 | 2026-11-16T11:02:14Z | 373 | PASS, 70/70 |
| 8 | 2026-11-16T11:08:27Z | 342 | PASS, 70/70 |
| 9 | 2026-11-16T11:14:09Z | 357 | PASS, 70/70 |
| 10 | 2026-11-16T11:20:11Z | 351 | PASS, 70/70 |

A separate 70/70 pass began before the final catalogue-name correction and is
excluded from these ten. The source stayed unchanged throughout the counted runs.

PASS: Full typecheck, including all workspaces, packaging and the dev stack.
The first typecheck caught an optional logger passed as `undefined`; giving the
fixture a default logger fixed that type error before the successful full rerun.
PASS: Clean `npm ci`; the requested shared NATS and Lychee links are executable.

FAIL: A preliminary whole-file run, started before the final assertion changes,
passed 69 cases and timed out at 30 seconds in the unchanged pending-start
lease-loss case. Its isolated run under CPU load passed in 21.73 seconds; the
cause of the preliminary timeout remains unassigned. It is excluded from the
final consecutive-run evidence. No timeout was raised and no retry was added.

PASS: The final 18-test leadership file passed twice, in 25.76 and 19.71 seconds,
under `nice -n 10`. The 14 release-matrix cases passed in 134.03 seconds after
the final-append result assertion was added. An earlier successful-release check
exposed the asynchronous socket execution assertion; the existing fixture's
execution condition now determines when that assertion runs.

PASS: Event catalogue agreement (174 types), Knip, changed-file ESLint without
warnings, lint-debt, whole-stream reads (312 known, five rebuild reads), changelog
lint and Markdown lint. Knip reported its two existing configuration hints.

## Fresh secondary stack

Journey on a fresh dev stack: PASS (core journey).

PASS: Secondary stack 1 was claimed through `infra/dev-stack/claim.sh` and started
with `infra/dev-stack/up.sh --fresh`, using the local model stub and the supplied
`ZITADEL_KEY_FILE` reference. Startup began at 11:26:49 UTC on the source head above.
The one-minute load was 2.04 before startup. It rose to an observed 14.42 during
the in-flight journey; no other test batch or repository build ran alongside it.

- PASS: Owner and member sign-in, PKCE, hostile and missing logout-origin refusal,
  wrong-organisation refusal, expired sessions and model-grant history.
- PASS: Member join reached PostgreSQL, OpenFGA and the live WebSocket. New member
  and assistant model grants reached OpenFGA before chat.
- PASS: Chat streamed, reloaded without duplicates and retained partial text after
  Stop and reload at 390 px and 1280 px. First-token times were 8,055 ms and
  3,398 ms respectively; completion took 10,076 ms and 5,887 ms.
- PASS: Upload scanning, bounded context, previews, reload and EICAR/type/size
  refusal at both widths. The runner reported one upload retry and zero preview
  retries at each width; no retry or timeout was added by this change.
- PASS: Live view refused access without a grant, showed the real desktop after a
  grant, and cleared pixels with audited Stop on revocation. Revocation took
  393 ms at 390 px and 178 ms at 1280 px.
- PASS: HTTP chat, projection and browser reconnect, PDF processing, suspended
  computer wake, assistant/computer join, resume and disk-preserving Pod replacement.
- PASS: Event-derived integration rows, anonymous/member refusal, private action
  history access, organisation metadata without private text and process-log canaries.
- PASS: Idempotent paying-group migration, paying-group and assistant ceilings at
  both widths, over-ceiling refusal and saved ceilings after reload.
- PASS: Member and MCP catalogue replay verification, ID-token boundaries, form
  sign-out, credential-required reauthentication and loopback-only secondary ports.
- NOT RUN: Approval journey, which the core runner explicitly skips while its
  remaining work is unfinished. Optional Phase 4 journeys were not requested.

## Screenshots and cleanup

Both new screenshots were copied before teardown. Their modification times were
checked against the start of this fresh run. Both were visually inspected: they
show the synthetic chat fixture and contain no email address, key or host path.

- [Chat at 1280 px](chat-1280.png)
- [Chat at 390 px](chat-390.png)

PASS: Fresh startup and the core journey returned 0. `infra/dev-stack/down.sh`
returned 0 and secondary status reported `free`. The worktree is retained.
Generated changes to shared journey evidence were preserved privately and the
tracked originals restored; the requested receipt and screenshots remain here.

NOT RUN: Full root test suite. CI is left to the draft PR and is not awaited.

PASS: Public-privacy and full-range secret scans before the push.
