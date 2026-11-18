# Clock checks

Date: 18 November 2026. Production changes: 247 lines, 145 added and 102 deleted.
No dependency or deadline length changed. This is slice 1 of 2 for #1043.

## Scope

`Clock` and `systemClock` live in the event-store package. Stores expose their
selected clock. Reads, summaries, append retries and the read deadline timer use it.
The seven requested access checks use that clock, including the fallback access
limit now in `budget-writer.ts`. Narrowed store types and reader adapters forward it.
`decision.ts` changes only its initial clock read, to reduce conflict with PR #1149.

The manual fixture clock is opt-in. Other models timing stays for slice 2.
There are 198 remaining `performance.now()` lines across both source trees,
including the one in `clock.ts`, and 31 remaining performance spies in their tests.
These are counts of the scoped remainder, not a claim that the whole ticket is done.

## Test-first log

1. `54ce37a44`: six clock contract tests failed because the clock API did not exist.
2. `d862a18e9`: manual access tests failed on real-clock expiry and fallback deadlines.
3. `e803c2c5e`: four credential tests failed with the original clock reads restored.
4. `25d1e8e79`: both decision tests failed with the original clock read restored.
5. `1930cb7a5`: added the implementation and forwarded clocks through existing readers.
6. `2a225b20e`: removed the replaced fake-timer cleanup.
7. `f50761164`: used an integer starting tick for an exact timer assertion. The first
   broad batch had 822 passes and one failure: floating-point subtraction produced
   `1999.999999999999` for that assertion. No production timing changed.

The first decision attempt could not start its gateway fixture because the local
binary was absent. The installed pinned gateway was linked, and both cases then
failed on the expected clock assertion before the one-line source swap.
The first credential expiry test reached the store's refusal before the credential
check. Its final form isolates the credential check from storage expiry.

## Clock-source mutation proof

Each site was changed back to `performance.now()` on its own. Both tests failed
for each of the seven changes. Every change was restored before normal tests ran.
No mutation was committed.

| Site | Stopped-clock test | Advanced-clock test |
| --- | --- | --- |
| Authority confirmation | Fails with old source | Fails with old source |
| Paying-group authority | Fails with old source | Fails with old source |
| Decision admission | Fails with old source | Fails with old source |
| Credential release | Fails with old source | Fails with old source |
| Credential send | Fails with old source | Fails with old source |
| Actor queue | Fails with old source | Fails with old source |
| Fallback access limit | Fails with old source | Fails with old source |

## Gates

- PASS: typecheck, including package and dev-stack code.
- PASS: event catalogue, 174 event types.
- PASS: Knip, with two existing configuration hints.
- PASS: changelog lint, changed-file ESLint, Markdown lint, README and lint-debt checks.
- PASS: every changed test passed at least twice. The complete app/library run
  passed 22 files and 843 cases. Five supplementary files passed 22 cases after
  the integer-tick fix and type plumbing. The two first-loaded memory files were
  repeated after cleanup and passed all 324 cases.
- PASS: the private-memory backend file passed its three cases twice using its own
  Vitest configuration. It is outside the root Vitest include pattern.
- NOT RUN: web tests and build; web source is unchanged.
- NOT RUN: independent review and hosted CI; those belong to the orchestrator.

Tests, compilation and lint ran under `nice -n 10`. Database tests used the shared
disposable test database. No full root test suite ran.

## Make it right

Reused `createEventStore` for fixture construction rather than copying its connection
and timeout setup. Shared the actor's named clock options in one helper. Kept the
clock API in its own small module and retained existing access and error outcomes.
Removed four performance spies and one fake-timer setup from the moved tests.
Removed the fake-timer cleanup after that setup was gone. No size limit was raised.

## Timers left for slice 2

The eleven remaining models `setTimeout` calls are unchanged:

- `mcp-dispatch.ts`: upstream socket timeout and exchange timer.
- `gateway.ts`: readiness socket timeout.
- `mcp-catalogue-watch.ts`: catalogue wait.
- `egress-relay.ts`: proof watchdog and pass expiry.
- `egress-startup.ts`: startup wait.
- `oauth-exchange.ts`: exchange timeout.
- `hosted-verification.ts`: verification wait.
- `credential-broker.ts`: the separate 30-second material discard timer.
- `private-callers.ts`: caller expiry.
