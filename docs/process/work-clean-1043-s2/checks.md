# Clock migration checks

Source commit: recorded with the final journey head in [journey.md](journey.md).

The clock keeps every existing duration. There is no event, access or deadline-length
change, and no new dependency. Narrowed stores include `clock` wherever they create
or check a deadline. Gateway test stores use `satisfies` to catch missing fields. The shared routine
fixture helper also uses `manualClock()` while server code still reads the adapter.

## Local checks

| Check | Result |
| --- | --- |
| Clean `npm ci` and pinned test tools | PASS |
| Workspace and infrastructure typecheck | PASS |
| ESLint on changed code | PASS |
| Event catalogue | PASS: 174 event types agree |
| Knip | PASS; two existing configuration hints |
| Changelog | PASS |
| Markdownlint | PASS |
| Lint debt and whole-stream read counts | PASS; no new whole-stream read |
| Targeted timing-sensitive test files, twice | PASS: original 100 files |
| Changed tests, twice | PASS: 39 files |
| Models suite beside volume stress | PASS: repeat has 2,836 passes; two opt-in skips |
| Volume stress | [PASS: 10/10](volume.md) |
| Fresh CORE journey | [PASS: required CORE path](journey.md); approval step NOT RUN |

Lint, typecheck, builds and tests run under `nice -n 10`. No full root test suite
was started. The [file audit](test-file-runs.json) covers 116 distinct files, with no file missing
a second passing run. The test runs use at most two workers, except the consecutive volume
runs, which use one worker.

The first broad attempt found a missing pinned gateway binary in the new worktree.
The normal `pretest` setup installed it, then the test batch was restarted.
The first models suite finished with 2,827 passes, two skips and one volume-test
timeout. The [failure log](models-first-failure.txt) is retained. The corrected
fixture stops model time without stopping storage retry waits; its forced NATS
failure regression passes. The repeated suite passed in 2,639.06 seconds. Native
consent capture and the three real OpenAI calls were skipped; those opt-in
conditions are NOT RUN.

The first timing batch finished with 5,145 passes, seven failures and one opt-in
skip. The approval step-up browser case at 390 px is opt-in and NOT RUN. It is not
claimed by the CORE journey. Its [failure details](timing-first-failure.txt) are retained. Routine tests
now reuse manual time during fixture admission; expiry checks remain in test bodies.
The startup timer test advances the proof clock separately from native timers.
The repaired routine callers passed their complete files again. Further routine checks
found admission expiry before the intended send and refusal stages. Their
[failure log](routine-first-failure.txt) and [additional sender errors](sender-additional-failures.json)
are retained. The shared routine helper now uses the manual clock; running-turn
tests hold admission time, then measure Stop and refusal handling in real time.

## Regression probes

The first committed test failed because a retry continued after the injected clock
reached 2,000 ms. Another committed failing test caught cancellation after a sleep
had resolved but before its callback ran. Both now pass.

Four isolated copies then reverted one clock read each. All four failed their
manual-clock tests for the expected reason. Product source was unchanged by these
probes; the copies were kept in the ignored tools directory while they ran.

- [Retry boundary](probe-retry.txt).
- [Managed history deadline](probe-history.txt).
- [Credential delivery at the deadline](probe-credential-delivery.txt).
- [Custody must not open after expiry](probe-credential-start.txt).

A temporary direct clock read also failed ESLint with `no-restricted-properties`.
The [lint output](lint-probe.txt) records the error. The temporary source was removed.

## Test scope

The slice brief asks to move tests that break onto the manual clock. Another 27
library assertions now use the shared manual clock as well. Three performance spies
remain for code outside the named production scope: PostgreSQL lock acquisition,
PostgreSQL connection acquisition, and backup export bounds. The older issue
checklist's zero-spy condition is **FAIL: three adapter sites remain**. A scope
clarification was requested. No broader adapter changes are included.

The expanded timing batch finished with 5,563 passes, 22 failures and one opt-in
skip. [Failure details](timing-expanded-failures.json) are retained. Twenty-one failures came from an intermediate fixture helper rename and
three mistaken mock cleanup replacements while the batch was still running. Those
self-check defects were corrected, then all 16 migrated library files were repeated against the stable helper.
The first repeat passed 1,366 tests. The second passed 1,365 and exposed one [native
hold recovery failure](native-held-failure.json) whose original permission aged during real service restart.
That success case now holds both the model clock and wall-clock permission expiry.
A [committed failing test](native-held-red.txt) pins its injected time; the native grant helper must read
`store.clock` when starting the check. The complete native-budget file passed all 46 tests on both repeats after the fix. The remaining browser failure exposed an
ambiguous response matcher: it could accept the HTML page rather than the tools
API response. The repaired test validates the API payload and keeps admission time
on the manual clock. Its complete file passed all 97 tests once. A concurrent repeat reached the
existing 60-second Angular startup bound while still reporting `Building...`, with
96 passes and that one failure. [The failure](browser-build-bound.json) is retained.
No timeout was lengthened. An isolated repeat also reached the same startup bound while host load was
between 8 and 16; its [failure](browser-isolated-build-bound.json) is retained.
The final browser repeats wait for five continuous minutes below load 6, with no
secondary or package stack active. This changes scheduling, not a test timeout. The first quiet-host repeat passed
all 97 tests in 296.90 seconds. The second passed all 97 in 263.83 seconds.
The [capacity log](browser-capacity.txt) records the quiet-host check.

## Native timers retained

The following native timers remain because they time fixed service operations or
wall-clock token expiry, rather than a computed monotonic deadline or retry wait:

| File | Timer and reason |
| --- | --- |
| `egress-startup.ts` | Two-second shutdown flush bound |
| `egress-relay.ts` | Wall-clock permit expiry; keep its port reserved until expiry |
| `private-callers.ts` | Wall-clock private caller token expiry |
| `mcp-dispatch.ts` | Two fixed 30-second upstream request timeouts |
| `gateway.ts` | One-second listener socket probe |
| `hosted-verification.ts` | One-second verification request timeout |
| `oauth-exchange.ts` | Five-second OAuth request timeout |
| `mcp-catalogue-watch.ts` | Configured duration of one catalogue check |
| `clock-timer.ts` | Native system-clock adapter preserves timer reference behaviour |

The relay watchdog and credential material discard timer now accept the injected
clock. The credential lookup deadline and gateway readiness retry wait use its
`sleep`. Fixed periodic checks and wall-clock event and token timestamps are unchanged.
The 17 remaining long real waits each have a `// real wait:` explanation naming
the service they hold or wait for.

## Make it right

Shared callback timing and cancellation between the credential discard timer and
relay watchdog. Kept the system timer's reference behaviour, including the relay's
`unref`. Put the ceiling preparation timeout beside its existing reader and reused
one named actor type. This keeps the actor within its existing file limit without
moving a whole-stream read. Passed a named clock through helpers that have no store.
Reused the existing routine fixture clock and removed duplicate fixed-clock
functions from composition and sender tests. Kept the sender file below its
existing cap. Moved the session admission wrapper into the shared routine clock
helper after the final file-size check caught nine extra lines. Both full session
repeats passed all 385 tests after that extraction. Lowered one obsolete parameter-count suppression. Shared the store-time test controller instead of keeping 27 performance spies.
Split the PostgreSQL slow-connection fixture into a named helper to keep its caller
within the existing cap. Extracted the browser tool-policy actions and exact API
response check, removing the old inline callbacks. No size limit was raised.

Approval changes remain direct clock swaps. Decision timing uses named options
and reuses the request’s existing memory claims. Dispatch evidence and egress
directory checks have named responsibilities. The [review fixes](review-round-1.md)
record refusal probes, size reductions and the unchanged behaviour checks.

The original reviewed change shipped **609 added plus deleted lines**, including
the new timer helper. The review fix receipt records the extraction and final gates.
