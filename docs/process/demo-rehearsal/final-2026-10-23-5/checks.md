# Source checks

Checks ran after secondary slot 1 was removed, under `nice -n 10`.
Tests set `PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`.
These demo fixtures and event schema tests do not use a database. No tests changed.

| Check | Result | Duration |
| --- | --- | --- |
| Existing demo fixtures, first run (52 tests) | PASS | 81,915 ms |
| Existing demo fixtures, second run (52 tests) | PASS | 88,715 ms |
| `libs/events/test/security-rules.test.ts` (438 tests) | PASS | 3,792 ms |
| `npm run lint` | PASS | 410,190 ms |
| Typecheck in the interrupted runner | PARTIAL | Not recorded |
| `npm run typecheck`, complete rerun | PASS | 292,010 ms |
| `npm run check:events` | PASS | 832 ms |
| `npm run lint:unused` (Knip) | PASS | 6,282 ms |
| `npm run lint:changelog` | PASS | 412 ms |

The first validation runner ended with exit 143 before it recorded typecheck's
result. That run is **PARTIAL**. The complete typecheck rerun passed in a separate,
shorter batch. No failed product step or paid call was retried. Code lint reported
no errors and 24 existing warnings. Knip reported two existing configuration hints.
[Machine-readable check records](checks.json) retain both typecheck outcomes.

Both fixture runs used `node --experimental-strip-types --test --test-concurrency=1`
with the nine `infra/dev-stack/demo*.test.ts` files. The security check used
`vitest run libs/events/test/security-rules.test.ts --maxWorkers=2`.
Validation used `NODE_OPTIONS=--max-old-space-size=6144`.

All twenty script results, 68 published picture hashes, spending totals and restored
ceilings agree: **PASS**. Publication checks found no email addresses, provider keys
or bearer tokens in the text. Screenshots masked these values at capture time.
Protected authority and security tests are unchanged. No product code, checker,
event contract or dependency changed. Full root suite: **NOT RUN**, as requested.
CI is left to the orchestrator without waiting.
