# Current memory checks after offline restore

Part of #15. Overall PARTIAL. Live recovery NOT RUN.

## Scope

The offline helper restores events and objects, then calls the existing current
memory check. The archive source is separate from the trusted current deletion
evidence. The proposed key folder must already exist. No key is copied or changed.
One cancellation signal and deadline cover all three steps. Uncertain completion
never reaches the next step. Targets stay isolated, and admission stays closed.

The result covers events, objects and custody checks only. It starts no replay,
read server or database connection. Full comparisons, CNPG/WAL and database restore,
computer volumes, credential renewal and reopening remain later work. The backup
set remains incomplete.

## Dependencies

The build started from `c3cea1c18324646f6cf82af08095356c56b7c84c` on main.

| Dependency | Merge commit |
| --- | --- |
| Event restore, #711 | `891d9d6b7ff1efa044f387ea18016abd8d574291` |
| Object restore, #740 | `c3e7ae2e2f675151c9f02be7743822324a022234` |
| Current custody checks, #713 | `939dfcdf7bd004748b10cfab6381255241b3e5dd` |
| File comparison fixture, #746 | `834e9209d5272c7ad8711f28b3bff4cf29514616` |
| Offline sequence, #751 | `c3cea1c18324646f6cf82af08095356c56b7c84c` |

## Builder checks

Every suite uses `nice -n 10` and one worker. PostgreSQL is a throwaway fixture
with `PG_TEST_URL`; NATS and MinIO are disposable test services. No dev stack,
model call or full root suite is used.

- PASS: `npm ci` and the requested local tool links.
- PASS: failing-first evidence, commit `3ff160f1d`. All 15 new cases failed before
  the wrapper called the existing memory check.
- PASS: 635 tests across eight restore, memory-key and security files. This includes
  the unchanged `libs/events/test/security-rules.test.ts`.
- PASS: full `npm run typecheck`, followed by the final server typecheck.
- PASS: `npm run check:events` (156 types) and Knip (`npm run lint:unused`).
- PASS: first final run, 50 tests across both changed files and
  `apps/ops/test/memory-replay.test.ts`.
- PASS: `npm run lint:changelog`.
- PASS: second final run, all 48 tests in both changed files.
- PASS: full `npm run lint`, with zero errors and 27 existing code warnings.
- PASS: removed the throwaway PostgreSQL container with its volumes.

The first implementation run passed 47 of 48 tests. One fixture replaced a NATS
reply without keeping its bytes, so it refused before the intended inventory fault.
The fixture now keeps the reply intact, validates changed fields, and checks that
history changes were injected. Focused lint passes after removing unsafe test casts.

The integrated fixture places a healthy fact before invalid custody, and asserts
zero decryption for every custody refusal. Wrong-key authentication is separate.
Current permanent markers keep forgotten and derived facts unreadable. Prepared
folders remain unchanged after success, refusal and cancellation, except for the
explicit inventory fault injected by the test. Failed or uncertain event/object
completion never calls the memory validator. Exercised probes count zero database,
replay, scheduler, model, tool, scan, delivery and credential-release activity.

The regression selection was:

```sh
nice -n 10 npx vitest run --maxWorkers=1 \
  apps/server/test/recovery-custody.test.ts \
  apps/server/test/recovery-restore.test.ts \
  apps/server/test/recovery-event-target.test.ts \
  apps/server/test/object-restore.test.ts \
  libs/event-store/test/event-restore.test.ts \
  libs/projections/test/memory-restore.test.ts \
  libs/projections/test/memory-keys.test.ts \
  libs/events/test/security-rules.test.ts
```

The final repetitions select `recovery-custody.test.ts` and
`recovery-restore.test.ts` from that command. The first also selects
`apps/ops/test/memory-replay.test.ts`. All runs have the disposable database URL
in `PG_TEST_URL`.

## Remaining qualification

Live recovery is NOT RUN. The set is incomplete and admission remains closed.
The standalone target and trusted-operator limits of the existing restore helpers
still apply. A frozen archive is not evidence of current deletion state.

## Private path protection (27 October 2026)

Source: `435104db2e99af8a75b3294d79450ae04a24d1ac`. The test runs used
`851ef94415a7a30997a10a4e98246c972805d307`, before the final rebase. All
`.ts`, `.js` and `.json` files are unchanged after that rebase.

The branch was rebased onto fetched `origin/main` at
`cfe2fea7c3edffbc648d575207e47ce0f3ff1783`. Main advanced during checks, so
a final rebase includes `6718d0bf534dd6e801042f589d62c6d6fdfc5977`. It finished
successfully. The README conflict keeps the current computer-volume, database-recovery
and memory-key descriptions. The added main commit changes chart and preflight
files, their tests and documentation; it changes none of the tested restore code.

Docker now starts from the private credential directory and receives only the
filename `environment`. Directory creation is inside the setup error handler.
Explicit close returns a fixed cleanup refusal. Setup keeps its original fixed
provisioning refusal even when cleanup fails, and cleanup still attempts both
container and directory removal.

PASS: failing-first commit `531f5a5c4` (now `1b4eade69` after rebase) contains the
new regression tests before the implementation change. Nine cases failed against the old implementation, including
an assertion on the actual Docker launch arguments. Two cases for already sanitised
write failures passed. After the fix, all 11 cases passed with real disposable MinIO.
The tests inject ENOSPC and EACCES during setup, multiple removal failures, and
simultaneous Docker and directory cleanup failures. They remove their own containers
and volumes after restoring the real cleanup functions.

The first typecheck found a missing `never` return type on the deliberately throwing
test helper. That annotation is now explicit; the test assertions are unchanged.

The checks use `nice -n 10`. Tests use one worker, disposable NATS and MinIO, and
a fresh throwaway PostgreSQL 17.6 container. The projection run uses that container's
reported loopback port in `PG_TEST_URL`, following the throwaway-database rule.
The provisioner-only failing-first and first passing runs use the supplied test URL.
No dev stack is claimed or started. The full root suite and live recovery are NOT RUN.
Overall recovery remains PARTIAL.

- PASS: first regression run, 648 tests across ten files.
- PASS: full `npm run typecheck` after the test-helper annotation fix.
- PASS: full `npm run lint`, including Knip (`npm run lint:unused`). ESLint reports
  zero errors and 30 warnings in unchanged code.
- PASS: `npm run check:events`, with all 156 event types agreeing.
- PASS: separate `npm run lint:changelog`, also repeated within full lint.

Both regression runs select these files:

```sh
nice -n 10 npx vitest run --maxWorkers=1 \
  apps/server/test/disposable-object-target.test.ts \
  apps/server/test/recovery-custody.test.ts \
  apps/server/test/recovery-restore.test.ts \
  apps/server/test/recovery-event-target.test.ts \
  apps/server/test/object-restore.test.ts \
  libs/event-store/test/event-restore.test.ts \
  libs/projections/test/memory-restore.test.ts \
  libs/projections/test/memory-keys.test.ts \
  apps/ops/test/memory-replay.test.ts \
  libs/events/test/security-rules.test.ts
```

- PASS: second identical regression run, 648 tests across ten files. The first run
  took 414.77 seconds; the second took 435.00 seconds.
- PASS: removed the throwaway PostgreSQL container with `docker rm -f -v`.
- PASS: after the final rebase, 531 chart-render, CNPG-installer and preflight tests
  across the three imported test files. These use chart rendering and isolated
  command fixtures, not a running installation.
- PASS: documentation and changelog checks after the final rebase.
