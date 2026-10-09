# Memory projection checks

9 October 2026. Tested source: `5939f87d`. Test-first commit: `006e16d9`.
Environment: local worktree, Node 22.23.3, PostgreSQL 17.11, real NATS with its
projection reader credentials, fresh disposable databases and key directories.
This was not a fresh installation of the whole application.

The expected result was identical current rows and full-text results after replay,
with no partial database writes on failure and no key creation during replay.
The [integration tests](../../libs/projections/test/memory.test.ts) observed those results.

| Check | Result | Observed result |
| --- | --- | --- |
| First tests against the parent | FAIL (expected) | Three tests failed because memoryProjection did not exist, before implementation. |
| Focused event, runner and key tests, twice | PASS | 363 tests passed in each run. |
| Memory and operator replay tests, twice after the entrypoint refactor | PASS | Nine tests passed in each run, with no skipped tests. |
| `nice -n 10 npm run lint` | PASS | All stages passed; existing function-length warnings remain elsewhere. |
| `nice -n 10 npm run typecheck` | PASS | Every workspace passed; apps/ops passed again after the refactor. |
| `nice -n 10 npm run check:events` | PASS | All 98 event types matched the catalogue. |
| `nice -n 10 npx knip` | PASS | No unused code; two existing configuration hints. |
| `nice -n 10 npm run lint:changelog` | PASS | The branch release note passed. |
| Full root test suite | NOT RUN | Excluded by the requested scope. |
| Independent review and CI | NOT RUN | The draft awaits those checks. |
| Fresh-install customer journey and power loss | NOT RUN | Required before claiming the capability complete. |

The focused runs selected `libs/projections/test/{memory,memory-keys,runner}.test.ts`
and `libs/events/test/{parse,security-rules}.test.ts`. The replay runs selected
`libs/projections/test/memory.test.ts` and `apps/ops/test/replay.test.ts`.
