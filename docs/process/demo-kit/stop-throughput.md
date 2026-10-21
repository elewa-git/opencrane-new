# Saving long streamed replies

21 October 2026. Part of #32. **PARTIAL: the live Stop blocker remains.**
Final source: `90829ad8c`; measured/live source: `3cf0a4aa7`; base: `a7b564bf4`.
Test-first commits: `5bcb65b8f`, `f0d4fbf4c`, `f2bba6809` (corrected browser wait),
`636b2f7f9`, `0a9c3443c`. This is the first part, not a completed live capability.

## Cause and measurements

Read the requested rehearsal receipt, five JSON files and both fleet reports first.
The regression drives the real WebSocket receiver, report saving code and NATS
with 2,700 small reports and at most 32 outstanding acknowledgements. Each report
previously read history updates, encrypted text, appended an event and read it back.
Event parsing rebuilt its schema each time. Personal reply reports do not perform
individual authority checks or wait for projections. Reconnect replay is not paced
by this test; the live backlog remains unresolved.

| Measurement | Before | Instrumented after |
| --- | ---: | ---: |
| Total milliseconds | 35,937 | 3,159 |
| History reads / milliseconds | 5,400 / 23,973 | 345 / 2,149 |
| Append attempts / milliseconds | 2,700 / 8,989 | 171 / 461 |
| NATS requests / milliseconds | 13,501 / 19,478 | 866 / 2,211 |
| Encryption milliseconds | 1,016 | 73 |
| Event validation milliseconds | 10,446 | 143 |
| JSON parsing milliseconds | 758 | 78 |
| Competing Stop append milliseconds | Not measured | 162 |

Nested times overlap: do not add them. After counts include Stop and conflicts. The first uninstrumented run also failed:
51,528 milliseconds against a 10,000-millisecond bound. Final regression runs passed
in 3,110 and 4,764 milliseconds, with Stop appends in 180 and 185 milliseconds.
All use `nice -n 10`. `strace -f` observed zero `fsync` or `fdatasync` calls across
the instrumented benchmark and its children. NATS time includes storage work;
this does not measure synchronisation in the live computer's journal.

## Changes and qualification

Adjacent queued reply pieces share an encrypted event. Every original sequence
and digest remains checked during replay. Queue limits, access, money and memory
checks remain. Schemas are reused; validation results are not. #547's separate
accepted-after-disconnect fix is excluded. Live Stop first lost three append races
with HTTP 409. Failing-first tests now cover Stop append priority and manual Stop
in the separate polling path; both fixes pass their tests.

Direct sending subscribed one socket three times, causing a 1008 closure and false
lost-access display. It now subscribes once and shows reconnecting for busy 1013.
HTTP 503 remains unavailable; genuine refusals still clear access. The historical
503 exceptions were not recorded. Bounded reads can produce 503; their exact cause
in that rehearsal remains unproven.

- FAIL: two-second live Stop on claimed secondary slot 1. After the fixes, Stop
  saved with HTTP 200, but no computer closure appeared within 30 seconds. The
  stopped/reload check timed out; a repeat failed too. A later reply did not start.
- PASS: busy live message and approval reads both returned 200.
- NOT RUN: successful live partial-reply retention after Stop and reload.
- NOT RUN: paid confirmation because the live gate failed. No provider key was read.

The slot used loopback ports starting at 25100, never the owner stack or 44200.
Both company ceilings were 300 euro cents. Its temporary stand-in emitted up to
2,700 pieces three milliseconds apart. Earlier setup failures included a schema
composition error and a conversation worker exiting on a NATS timeout; a fresh
rebuild restored the worker before the live failures above.

## Checks, calls and cleanup

PASS: installation; 542 broader tests including unchanged authority tests and all
438 security checks; 70 repeated bridge checks; 23 focused tests twice; 71 browser
tests twice; typecheck, event catalogue and the full lint chain, including knip and
changelog checks. The first CI run on `afe27448d` failed the old report-conflict
expectation in `chat-summary.test.ts`. Its corrected check now verifies the new
stream position, the competing event and duplicate recovery. Those 12 tests passed
twice. The final pushed-head CI result is in the PR.
Paid calls: **none**. Charged: **0 cents**. Held with real providers: **0 cents**.
The task limit was 300 cents including holds; the earlier 75 cents is outside it.
PASS: released slot 1, restored and removed temporary source fixtures, and removed
`pgtest-demo-stop-throughput` with its volume. No owner resources were removed.
