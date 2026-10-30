# Initial personal memory delivery contract

For people, read [README.md](README.md) first.

Part of #97, P4-15 PR 5f. Builds on the [load contract](../p4-15-pr5d/README.robot.md).

`prepareInitialMemory` returns `load()` and `consume(consumer)`. Preparation retains the
exact `turnMemoryPreview` block. Each evidence command still makes one conditional append.
`load()` returns only loaded status and disabled dispatch. `consume` saves nothing and
returns no text or callback result. It calls the internal consumer only after a proved load.
The consumer receives the original block, never a new selection or a public response.

Consumption reserves the attempt before its first await and removes the retained block
immediately before calling the consumer. Failed validation keeps it for a retry with
fresh checks. Premature attempts and unknown appends clear it. Concurrent and repeated
delivery cannot send it again. A thrown or lost consumer reply keeps the references
recorded and cannot resend. Cold replay restores
references and status with execution unavailable; it cannot construct this live closure.

Release captures saved membership first and retains one permission decision per operation.
It reuses `prepareLoadedMemory`, `memoryRights` and the deployment-owned qualification
reader. The same collector run, image, host and installation must still qualify. No caller
PASS objects or bypass options are accepted. Saved membership removal keeps its specific
refusal even when another dependency fails; other errors expose only a fixed refusal.

Conversation and scope history load before the two-second access check. Only small access
streams enter that check. Separate activity checks read new turn and closure events.
The final global position read detects new activity. Each relevant access, scope and
activity stream then supplies all events through its own read, including events saved
after that global position. The existing turn classifier ignores other turns and ordinary
chat activity. Relevant access or turn changes refuse delivery; scope changes update the
selected-reference check directly. Other conversations never need to stop writing.
Each stream read has its own end position and keeps the original deadline. A synchronous
reference check catches expiry during the final await, including supporting facts.
The deployment's synchronous file confirmation catches withdrawn results. The consumer
runs immediately after these checks, without another await before receiving the block.

`initialMemoryInput` in the computer package accepts this block only for the matching
restricted personal turn. It uses the private input renderer, labels the original JSON,
and keeps it separate from trusted rules, rebuilt transcript and new message. It checks
all recorded identity fields against the expected binding. It grants no execution permission.
The returned frame is transient RAM input: callers must never journal it or render it twice.
Start and credential wiring remain PR 5g work; no production caller is connected here.

Limits remain 16,384 UTF-8 bytes for the whole selected block, 32 references, 24 KiB of
rebuilt transcript, 48 KiB of tools and 120 KiB for the complete returned JSON frame.
Escaping, metadata and the new message count. Overflow refuses; no text is truncated.
No event, public API, mode, catalogue, approval or dependency changes are included.

## Own checks

### Original implementation

2026-10-30. Source: base `963d5130a` plus this branch’s changes. No image was built.

Local source checks use disposable NATS, PostgreSQL, OpenFGA and gateway fixtures.
The collector runs against simulated filesystem and Docker observations; it does not
qualify this host. Tests use `nice -n 10` and at most two workers. Service tests set `PG_TEST_URL` explicitly.

- Failing-first: PASS. Test commit `6d0c2e169` precedes implementation. The renderer was
  absent; a real-service rerun against the original server failed because `consume` was absent.
  The first server run lacked its gateway binary; that was a setup failure, then repaired.
- Final changed tests: PASS, 108/108 twice, with one worker per run.
- Lint, typecheck, event catalogue, Knip and changelog: PASS.
- Renderer, private transcript and unchanged security rules: PASS, 488 tests together.
- Initial delivery run: FAIL, 94/96 passed. Two load checks refused before consumption;
  a focused diagnostic passed all three selected cases without a load-logic change.
- Wider `memory.test.ts`: FAIL, 242/245 passed. Saved and concurrent correction recovery
  returned unavailable; binding replay exceeded 30 seconds. Causes remain unresolved.
  Long-history and unrelated-activity cases passed. These failures are not waived.
  Source readiness at that point was PARTIAL.
- Fresh-install native delivery, persistence scans, paid calls and CI: NOT RUN.
  Admission remains disabled. This change is input delivery code, not native enablement.

### Release availability and retry checks

2026-10-30. Rebased onto `37387baeb`. Run one started at `87c84156b`; run two uses
`b79e3d088`, which adds documentation and clearer guard bodies without changing behaviour.
No image was built. Each service test uses fresh disposable fixtures, not a fresh silo.
The deployment collector's filesystem and Docker observations remain simulated.

- PASS: failing-first tests. `fd264c0e6` records both sustained-activity failures before
  the fix. `d7b436d9f` records the failed retry before changing retention. Each failed
  with `memory_context_unavailable`, then passed after its corresponding fix.
- PASS: the focused sustained-activity and existing final-await cases, 9/9. The
  premature, concurrent, lost-reply and retry cases also passed, 5/5.
- PASS: run one, 363/363 across `memory-initial-delivery.test.ts`, `memory.test.ts`
  and `apps/computer/test/worker-input.test.ts`. The renderer's `turn-input.test.ts`
  passed separately, 22/22.
- PASS: run two, 356/356 across initial delivery, memory and the renderer. Initial
  delivery (89), memory (245) and renderer (22) therefore each passed twice.
  The earlier memory recovery and replay failures were not reproduced in either
  complete memory run; their earlier causes remain unknown.
- PASS: lint, typecheck, check:events, Knip and lint:changelog. A separate ESLint
  check passed after expanding the delivery module's guard bodies.
- NOT RUN: full root suite, fresh-install native delivery, persistence scans, paid
  calls and CI. Admission remains disabled.

Commands use `nice -n 10`. Both service runs use the supplied `PG_TEST_URL` and
`npx vitest run` with explicit test file paths and `--maxWorkers=1`.
The regression keeps saving three real unrelated turn-start events during every
deployment read until consumption finishes. Both another conversation and another
turn in the same conversation must allow exactly one delivery. The retry test
requires the original selection after a temporary read failure, even if new facts arrive.

Local logs: `/tmp/p4-15-pr5f-fix-red.log`, `/tmp/p4-15-pr5f-retry-red.log`,
`/tmp/p4-15-pr5f-fix-green.log`, `/tmp/p4-15-pr5f-retry-green.log`,
`/tmp/p4-15-pr5f-fix-tests-1.log`, `/tmp/p4-15-pr5f-fix-tests-2.log`,
`/tmp/p4-15-pr5f-fix-renderer-1.log`, `/tmp/p4-15-pr5f-fix-lint.log`,
`/tmp/p4-15-pr5f-fix-typecheck.log` and `/tmp/p4-15-pr5f-fix-events.log`.

### Late changes during the final stream reads

2026-10-30. Rebased onto `371087d3c`; the rebase completed. Both complete test runs
use code at `86eabdfac`. No image was built. Tests use disposable NATS, PostgreSQL
databases, OpenFGA and gateway fixtures on the shared development host. The supplied
local `PG_TEST_URL` is set for every service run. Deployment filesystem and Docker
measurements are simulated; these fixtures are not a fresh silo installation.

- PASS: failing-first proof at test commit `83b20c97e`. All five late changes
  reproduced delivery before the fix: membership removal, correction, Forget,
  conversation closure and computer replacement. Qualification withdrawal, expiry
  and unrelated activity passed their existing expected outcomes in the same run.
- PASS: all eight focused late-read cases after the fix. The five refusal cases
  now require no delivery and refuse a second attempt. Unrelated activity still
  permits exactly one delivery. Qualification withdrawal and expiry still refuse.
- PASS: both complete runs, 393/393 each across initial delivery (97), memory (245),
  renderer (22) and worker input (29). Existing assertions were kept unchanged.
- PASS: lint, typecheck, check:events, Knip and lint:changelog. Code lint reports
  zero errors and 34 warnings.
- NOT RUN: full root suite, fresh-install native delivery, persistence scans, paid
  calls and CI. Admission remains disabled.

All checks use `nice -n 10`. The two complete test runs each use `npx vitest run`
with the four explicit file paths and `--maxWorkers=1`; they overlap with at most
two test workers in total. Each stream supplies all events through its own read,
including events beyond the earlier global position. Relevant access and turn
changes refuse delivery. Scope changes update the selected-reference check.

Local logs: `/tmp/p4-15-pr5f-fix2-red.log`, `/tmp/p4-15-pr5f-fix2-green.log`,
`/tmp/p4-15-pr5f-fix2-tests-1.log`, `/tmp/p4-15-pr5f-fix2-tests-2.log`,
`/tmp/p4-15-pr5f-fix2-lint.log`, `/tmp/p4-15-pr5f-fix2-typecheck.log` and
`/tmp/p4-15-pr5f-fix2-events.log`.
