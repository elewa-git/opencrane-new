# Source checks

All checks ran after the secondary stack was removed, under `nice -n 10`.
Tests set `PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`.
These focused fixtures and schema tests do not use PostgreSQL. No test files changed.

| Check | Result | Duration |
| --- | --- | --- |
| Existing demo Node fixtures, first run | PASS, 41 tests | 78,660 ms |
| Existing demo Node fixtures, second run | PASS, 41 tests | 78,881 ms |
| `libs/events/test/security-rules.test.ts` | PASS, 438 tests | 4,732 ms |
| `npm run lint` | PASS, 0 errors and 24 existing warnings | 626,956 ms |
| `npm run typecheck` | PASS | 317,170 ms |
| `npm run check:events` | PASS | 994 ms |
| `npm run lint:unused` (Knip) | PASS | 9,869 ms |
| `npm run lint:changelog` | PASS | 481 ms |

The first combined check command was interrupted with exit code 143 during ESLint.
That lint attempt is **PARTIAL**; its completed fixture and security results were
retained. The standalone lint run in the table finished successfully. The reason
for the interruption was not established. No live journey was repeated.

The Node command used `--experimental-strip-types --test --test-concurrency=1`
with the eight `infra/dev-stack/demo*.test.ts` files. The security suite used
`vitest run libs/events/test/security-rules.test.ts --maxWorkers=2`.
Validation used `NODE_OPTIONS=--max-old-space-size=6144`.

Spending totals, all 20 script results and all 42 picture hashes: **PASS**.
Protected authority and security tests are unchanged. No application code, checker,
event contract or dependency changed. The receipt states the history-picture limitation.
Local full root suite: **NOT RUN**, as requested. GitHub CI is left to the orchestrator.
These source checks do not change the failed live qualification result.
