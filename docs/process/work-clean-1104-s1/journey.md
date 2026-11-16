# Routine leadership latency and fresh core journey

Date: 16 November 2026

Test source: `b97bbc61ca1cc6b4518fcccf54625f70fb8b1c9b`.

Environment: Linux, Node 22.23.3, real disposable PostgreSQL, NATS and OpenFGA.
Tests use the shared disposable test database. Routines remain disabled.

## Controlled reproductions

PASS: The test-first holder reproduction uses the actual advisory lock and makes a
query on that held PostgreSQL session take 1.2 seconds. The one-second ownership
check refuses. The old rule also permanently cancels its holder, although the
session still holds the lock. Both real time and a frozen `performance.now()` fail
at `A read timeout does not prove session loss`. Test-first commit `4402fac69`
was written and run before rebasing, as `07af0183c`.

PASS: A dispatch regression holds company preparation while the real background
monitor runs `SELECT pg_sleep(1.2)` on its held session. Restoring unconditional
cancellation reproduces the original `expected false to be true` before the final
release hook, with both clock modes. The fixed rule reaches that hook. A budget
reservation there must finish, and the final append must return `unavailable`,
with no release event or execution. The probe timeout must be logged too.
The session helper decorates the real lock and query; it never replaces ownership.

PASS: A second test-first reproduction freezes fixture time while sending the same
real delayed query. Holding only `performance.now()` leaves the native query timer
running: no logical time passes, but the check returns false. Commit `c31dcab42`
contains that failing fixture-clock test, written and run before rebasing as
`9ae9953a8`. The corrected fixture controls native timers and monotonic time through
the actual leadership path, so the real query completes within its unchanged
logical deadline.

## Production and fixture rules

PASS: Production distinguishes read expiry from other probe failures. An expired
check still returns false. It does not establish that PostgreSQL released the
session lock, so it does not permanently cancel the callback. A later successful
check must complete a fresh query on that same session. Other query errors,
session failure, shutdown and release still cancel. Acquisition, probe, access
and delivery deadlines are unchanged. No command retry or extra timeout was added.

PASS: The release matrix retains real events, projections, OpenFGA, budgets,
leadership and socket delivery. Each injected change must finish, and the actual
final append must have the expected status. Event and execution assertions remain.

Normal dispatch fixtures hold access-check time while real services reply. The
release matrix and scheduler success case also hold native acquisition and query
timers with Vitest, restoring them in `finally`. The deadline case explicitly
advances the clock by 2,001 ms. Real-latency and contention cases retain native
timers and test both monotonic clock modes. No synthetic lease remains.

PASS: The fourteen-second wake fixture advances a captured timestamp by exactly
14,000 ms. Binding a mutable performance spy caused recursion after its
implementation changed; capturing the number removes that introduced fixture bug
without changing its continuation, saved-run or execution assertions.

## Early-refusal diagnostics

PASS: Pending handler tests race entry against dispatch settlement. Early
completion or rejection reports outcome, phase and safe leadership records.
Failure diagnostics include append event types, result statuses and remaining
write-check time, using the owning observability library's memory sink. They
contain no event payload, key, account label or arbitrary callback text.

A loaded diagnostic reproduced refusal before credential acknowledgement. Its
final release append began with 337.5 ms left in the unchanged two-second access
check, took about 373 ms and returned `unavailable`. Dispatch rejected during
hand-off before that handler entered. No acquisition or probe failure was logged.
The old unconditional wait converted this early refusal into a 30-second timeout;
the guarded wait reports its actual phase. Fixture time now remains controlled
while reaching the handler. Ownership and execution assertions are unchanged.

The original preliminary pending-start lease-loss timeout and historical CI
failure lack recorded underlying errors, so their exact causes remain unassigned.
A separate exploratory real-clock latency run also missed the release hook
before detailed observations were added. Later passes do not explain those
historical failures. They are not described as unrelated or counted in the final
qualification results.

## Review findings and other gates

- PASS: The README gate reproduced the original growth from 275 to 276 lines.
  Rewriting the existing ops description restored 275; no baseline grew.
- PASS: Acquisition, callback-canary and probe assertions use `memorySink` through
  `@opencrane/observability/testing`. The missing export was reproduced in
  test-first commit `481be491a`, written and run before rebasing as `f06e9a604`.
  The library exports that exact testing entry. Runtime imports from tests remain
  prohibited by the dependency rules.
- PASS: Full typecheck, packaging and dev-stack typecheck; event catalogue agreement
  (174 types); Knip; dependency checks; changed-file ESLint without warnings;
  changelog and lint-debt checks. Knip reported its two existing configuration hints.
- PASS: Rebase completed onto `29d0d2cb7f473a93db7569ab69b46e9bf81ac540`.
  The updated main brought four more README baseline failures. Existing descriptions
  were shortened while retaining their contracts. README checks pass with
  `BASE_SHA=origin/main`; no baseline file was changed.
- FAIL / upstream: `lint:reads` already fails on that main commit. The ledger records
  two reads in `decision.ts` but finds one; it records two in `personal-tool-context.ts`
  but finds four. This PR adds no product whole-stream read and does not raise the
  ledger. [The failing main CI run](https://github.com/elewa-git/opencrane-new/actions/runs/43867578772)
  records the same failure. Repair or revert of the personal-key change remains needed.

## Runs before final qualification

FAIL: The first post-review batch passed five whole-file runs (73/73 each), then
stopped at run six (71/73). The scheduler success case refused and the
acknowledgement lease-loss case timed out before handler entry. The phase and
remaining-time diagnostics above were added before assigning a cause.

FAIL: The first rebased clock-control batch passed both 21-test leadership runs,
then passed 72/73 hand-off cases. It exposed the introduced performance-spy
recursion in the fourteen-second wake fixture. The corrected focused case passed.

An initial append-trace spy also caused recursion when later injection spies
rebound it. The trace now decorates the original append directly; the affected
14-case release matrix passed afterwards. An early probe-log matcher rejected
pino's extra safe error fields; the final matcher checks the required phase and
message. These failures are excluded from the final run count.

## Final loaded qualification

PASS: Ten whole-file runs on the test source above, 73/73 each (730/730 total).
Two isolated processes ran at once, each with one Vitest worker; at most two
workers were active. Every command used `nice -n 10` and the supplied disposable
PostgreSQL URL. A separate busy Python CPU process remained active for all ten.
No run was retried. The controller would stop starting new runs after any failure.
PostgreSQL database names, NATS servers, OpenFGA containers and temporary files
are unique to each fixture.

Command for each run:

```sh
nice -n 10 npx vitest run apps/server/test/routine-handoff.test.ts --maxWorkers=1
```

| Run | Started (UTC) | Seconds | Result |
| --- | --- | --- | --- |
| 1 | 2026-11-16T13:36:22Z | 670.03 | PASS, 73/73 |
| 2 | 2026-11-16T13:36:22Z | 663.28 | PASS, 73/73 |
| 3 | 2026-11-16T13:47:32Z | 544.07 | PASS, 73/73 |
| 4 | 2026-11-16T13:47:32Z | 544.76 | PASS, 73/73 |
| 5 | 2026-11-16T13:56:37Z | 426.28 | PASS, 73/73 |
| 6 | 2026-11-16T13:56:37Z | 429.92 | PASS, 73/73 |
| 7 | 2026-11-16T14:03:46Z | 524.74 | PASS, 73/73 |
| 8 | 2026-11-16T14:03:46Z | 525.29 | PASS, 73/73 |
| 9 | 2026-11-16T14:12:32Z | 514.37 | PASS, 73/73 |
| 10 | 2026-11-16T14:12:32Z | 508.22 | PASS, 73/73 |

PASS: The entire leadership file passed twice, 21/21 each, in 36.29 and 44.17
seconds under load, using `nice -n 10` and `--maxWorkers=2`. Those runs used
`695c9ba9a`; ops and observability code are unchanged through the test source
above. Both changed test files have passed at least twice. The real acquisition,
callback-canary, probe, session-loss and controlled-clock assertions all ran.

NOT RUN: Local full root suite. These are own checks, not an independent review result.

## Fresh secondary stack

Journey on a fresh dev stack: PASS (core journey).

Source: `b97bbc61ca1cc6b4518fcccf54625f70fb8b1c9b`.
Secondary slot 2 was claimed through `infra/dev-stack/claim.sh`, then started with
`nice -n 10 infra/dev-stack/up.sh --fresh`, using the local model stub and the
supplied `ZITADEL_KEY_FILE` path reference. No key value was printed or copied.
Startup began at 14:22:38 UTC. The one-minute host load before startup was 3.48.
Website readiness took 70,163 ms. No other check from this worktree ran alongside
the live journey. The final tests and CPU load process had already finished.

- PASS: Owner and member sign-in through real Zitadel and PKCE; hostile and missing
  logout Origin refusal; wrong-organisation and expired-session refusal; model grants.
- PASS: Member join reached PostgreSQL, OpenFGA and the live WebSocket. New member
  and assistant model grants reached OpenFGA before chat.
- PASS: Chat streamed and reloaded without duplicates. Stop retained partial text
  after reload at 390 and 1280 px. First tokens took 14,258 and 6,238 ms;
  completion took 15,591 and 8,266 ms respectively.
- PASS: Upload scanning, bounded context, previews, reload, and EICAR/type/size
  refusal at both widths. The existing runner reported one upload retry and zero
  preview retries at each width; no retry was added by this change.
- PASS: Live view refused access without a grant, showed the real desktop after a
  grant, and cleared pixels with audited Stop on revocation. Revocation took
  521 ms at 390 px and 384 ms at 1280 px.
- PASS: HTTP chat, projection and browser reconnect, PDF processing, suspended
  computer wake, assistant/computer join, resume and disk-preserving Pod replacement.
- PASS: Event-derived integration rows, anonymous/member refusal, private action
  history access, organisation metadata without private text and process-log canaries.
- PASS: Idempotent paying-group migration, paying-group and assistant ceilings at
  both widths, over-ceiling refusal and saved ceilings after reload.
- PASS: Member and MCP catalogue replay verification, ID-token boundaries,
  form sign-out, credential-required reauthentication and loopback-only ports.
- NOT RUN: Approval journey, which the core runner explicitly skips, and optional
  later journeys. Live automatic routine qualification remains NOT RUN; routines stay off.

## Screenshots and cleanup

The new screenshots were copied before teardown and checked against this run's
start time. Both were visually inspected: completed chat and retained stopped text
are visible, with no email address, key or host path. SHA-256 comparison confirmed
that the copied files are exactly the inspected images.

- [Chat at 1280 px](chat-1280.png)
- [Chat at 390 px](chat-390.png)

PASS: Fresh startup and the core journey returned 0. `infra/dev-stack/down.sh`
returned 0, and secondary status reported `free`. The run and cleanup finished at
14:42:52 UTC, taking 1,214.47 seconds in total. The worktree is retained.
Generated shared journey evidence was preserved privately and its tracked originals
restored. Only this receipt and the two requested screenshots are retained here.

CI remains subject to the inherited main read-gate failure described above;
the draft PR records the current CI result. No skipped CI step is claimed as passed.
