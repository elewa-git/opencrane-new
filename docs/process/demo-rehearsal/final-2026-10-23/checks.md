# Source checks

All checks ran after the secondary stack was removed. Tests, lint and typecheck used
`nice -n 10`. Tests set `PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`;
these focused fixtures and schema tests do not use PostgreSQL. No test files changed.

| Check | Result | Duration |
| --- | --- | --- |
| Existing demo Node fixtures, first run | PASS, 33 tests | 64,699 ms |
| Existing demo Node fixtures, second run | PASS, 33 tests | 71,486 ms |
| `libs/events/test/security-rules.test.ts` | PASS, 438 tests | 4,688 ms |
| `npm run lint` | PASS, 0 errors and 24 existing warnings | 512,527 ms |
| `npm run typecheck` | PASS | 280,795 ms |
| `npm run check:events` | PASS | 770 ms |
| `npm run lint:unused` (Knip) | PASS | 6,171 ms |
| `npm run lint:changelog` | PASS | 395 ms |

The Node command used `--experimental-strip-types --test --test-concurrency=1`
with the seven `infra/dev-stack/demo*.test.ts` files. The security suite used
`vitest run libs/events/test/security-rules.test.ts --maxWorkers=2`.
Validation used `NODE_OPTIONS=--max-old-space-size=6144`.

Spending totals and all 22 picture hashes: **PASS**. Protected authority and security
tests are unchanged. No application code, event contract or dependency changed.
Local full root suite: **NOT RUN**, as requested. GitHub CI is left to the orchestrator.
These source checks do not change the failed live qualification result.
