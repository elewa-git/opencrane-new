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
