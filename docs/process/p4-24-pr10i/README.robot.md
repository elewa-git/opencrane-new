# Routine scheduler delivery gate contract

Part of #106. This is the first, deliberately incomplete part of production wiring.

`runRoutineScheduler(options, delivery)` uses the existing `enabled` and `replay`
options. Disabled and replay calls return without any event-store or database
access. An enabled call without the checked delivery dependencies throws before a
claim. With a callback it uses `dispatchRoutineCandidates`, including the original
leader signal/check and saved due identity. The routines worker supplies
`ROUTINE_EXECUTION_ENABLED` at startup. Its shipped default is off; setting it to
true currently fails startup before projection work because production delivery
is not registered. `executionAvailable` stays false.

The production projection worker has no budget actor or bridge link. There is no
production callback or automatic tick in this part. Public reads remain false.
The existing sender, company checks, Stop and finish commands are unchanged.
No event or API field was added. The fresh-install journey is NOT RUN.

The regression starts `apps/ops/src/worker.ts` as a child process using test
NATS and PostgreSQL. Absent and false settings continue updating the routine
projection. True and invalid settings stop before claiming any run. A direct
helper test checks the exact missing-delivery refusal. Temporary removal of
the worker startup block, the disabled helper check and the missing-delivery
check made their respective tests fail; each source edit was restored.

## Own checks

See [receipt.md](receipt.md).
