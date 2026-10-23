# Source checks

All checks ran after secondary slot 1 was removed, under `nice -n 10`.
Tests set `PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`.
These demo fixtures and event schema tests do not use a database. No tests changed.

| Check | Result | Duration |
| --- | --- | --- |
| Existing demo fixtures, first run | PASS, 44 tests | 80,024 ms |
| Existing demo fixtures, second run | PASS, 44 tests | 85,828 ms |
| `libs/events/test/security-rules.test.ts` | PASS, 438 tests | 5,771 ms |
| `npm run lint`, corrected run | PASS | 621,735 ms |
| `npm run typecheck` | PASS | 348,330 ms |
| `npm run check:events` | PASS | 1,422 ms |
| `npm run lint:unused` (Knip) | PASS | 9,525 ms |
| `npm run lint:changelog` | PASS | 807 ms |

The first lint run was **FAIL** after 636,565 ms. A receipt line beginning with
`#611` was read as a Markdown heading. The wording was corrected, and the focused
Markdown check then passed. The table records the full rerun separately.
Code lint reported no errors and 24 existing warnings. Knip reported two existing
configuration hints. These checks do not change the failed live qualification.

Both fixture runs used `node --experimental-strip-types --test --test-concurrency=1`
with the nine `infra/dev-stack/demo*.test.ts` files. The security check used
`vitest run libs/events/test/security-rules.test.ts --maxWorkers=2`.
Validation used `NODE_OPTIONS=--max-old-space-size=6144`.

All 20 script results, 26 published picture hashes, spending totals and restored
ceilings agree: **PASS**. Publication checks found no email addresses, provider keys or bearer
tokens. Protected authority and security tests are unchanged. No application code,
checker, event contract or dependency changed. Full root suite: **NOT RUN**, as requested.
CI is left to the orchestrator without waiting.
