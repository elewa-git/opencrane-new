# Memory projection checks

9 October 2026. Tested source: `358bd823`. Review-fix tests were committed
first in `796c818c`; the original feature tests were committed in `006e16d9`.
Environment: local worktree, Node 22.23.3, PostgreSQL 17.6, real NATS with
projection-reader credentials, disposable databases and private key directories.
This was not a fresh installation of the whole application.

Before the fixes, tests reproduced duplicate dependencies and mismatched key
references accepted at append, stale writes replacing current rows, key deletion
changing history, preparation outside the handler and rebuild losing live rows.
Temporary removal of guards made 11 selected refusal tests fail. All temporary
changes were restored before implementation.

The final tests check refusals for unsupported memory changes, invalid saved data,
direct application, damaged keys, failed GCM authentication, repeated dependencies,
mismatched key references, replay with `--verify` and replay without locking.
They also check scope isolation through the product query, stable change history,
revision protection, preparation inside the handler callback with safe failure logs,
and preservation of rows and runner records when the rebuild's first checks fail.

| Check | Result | Observed result |
| --- | --- | --- |
| Failing-first tests and guard-removal probes | PASS | Expected failures were observed before fixes. |
| Four changed test files, twice | PASS | 44 tests passed per run, with no skips. |
| Broader focused regression run | PASS | 694 tests passed across 14 files. |
| `nice -n 10 npm run lint` | PASS | All stages passed; existing function-length warnings remain elsewhere. |
| `nice -n 10 npm run typecheck` | PASS | Every workspace passed. |
| `nice -n 10 npm run check:events` | PASS | All 98 event types matched the catalogue. |
| `nice -n 10 npm run lint:unused` (Knip) | PASS | No unused code; two existing configuration hints. |
| `nice -n 10 npm run lint:changelog` | PASS | The branch release note passed. |
| Full root test suite | NOT RUN | Excluded by the requested scope. |
| Review verification and hosted CI | NOT RUN | Pending for these fixes. |
| Fresh-install customer journey and power loss | NOT RUN | Required before claiming the capability complete. |

The repeated runs selected `libs/projections/test/memory.test.ts`,
`libs/projections/test/memory-keys.test.ts`, `libs/projections/test/preparation.test.ts`
and `apps/ops/test/memory-replay.test.ts`. The broader run also selected
`libs/projections/test/runner.test.ts`, `libs/events/test` and
`libs/event-store/test/append.test.ts`.

Rebuild checks saved events and keys before replacing any tables. A failed first
check preserves current rows, processed ids, checkpoint and generation. It reads
keys again during application; a later storage failure can still leave a completed
prefix. Readers remain stopped until a successful rerun. Replay never provisions
or deletes keys. The disposable PostgreSQL container and its volume were removed.
