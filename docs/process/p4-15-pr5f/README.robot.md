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
The final event-store position bounds new rows in the relevant access, scope and activity
streams. The existing turn classifier ignores other turns and ordinary chat activity.
Only relevant access or turn changes repeat validation within the same deadline; scope
changes update the reference check directly. Other conversations never need to stop
writing. Each tail read uses the captured position as its boundary. A synchronous
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
  Overall source readiness remains PARTIAL until the wider failures are resolved.
- Fresh-install native delivery, persistence scans, paid calls and CI: NOT RUN.
  Admission remains disabled. This change is input delivery code, not native enablement.
