# Source checks

Checks ran after secondary slot 1 was removed. Every test, lint and typecheck command
used `nice -n 10`. No test files changed; the existing demo fixtures ran twice.

| Check | Result | Duration |
| --- | --- | --- |
| Existing demo fixtures, first run | PASS, 44 tests | 119,451 ms |
| Existing demo fixtures, second run | PASS, 44 tests | 103,848 ms |
| Event-security rules | PASS, 438 tests | 5,658 ms |
| Repository lint | PASS, 0 errors and 24 existing warnings | 618,165 ms |
| Workspace and package typecheck | PASS | 365,815 ms |
| Event catalogue | PASS, 149 event types | 1,238 ms |
| Knip | PASS | 14,110 ms |
| Changelog | PASS | 553 ms |

The demo command was `node --experimental-strip-types --test --test-concurrency=1
infra/dev-stack/demo*.test.ts`. Event-security used `vitest run
libs/events/test/security-rules.test.ts --maxWorkers=2`.
Tests set `PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`.
These fixtures and schema tests use no database. No root or projection suite ran,
so this task needed no PostgreSQL test container. Validation used a 6 GiB Node heap.

`npm ci`: PASS. NATS and Lychee symlinks: PASS. Picture hashes, spending arithmetic,
and the twenty NOT RUN script entries: PASS. Protected authority and event-security
tests are unchanged. No application code, event contract or dependency changed.

Repository lint includes dependency direction, Knip, Markdown, offline links, fixture
rules, reviewed licences and changelog validation.

Full root suite: **NOT RUN**, as requested. CI is left to the orchestrator and is
not awaited. Passing source checks do not change the failed live qualification.
Private check logs are in `/tmp/demo-final-rehearsal-3-evidence/`.
