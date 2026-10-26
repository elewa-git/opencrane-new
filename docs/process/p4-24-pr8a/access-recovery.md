# Routine claim access and recovery checks

Date: 26 October 2026. Part of #106 and PR #727.
Base: `2607ab2e0`. Rebase completed and the base is an ancestor of this branch.
Source: `6a5426f421da01c9f92adeaf0a24190ba1522868`.
Test-first commits: `405fed22f` and `830f093d7`.

## Change

Routine claims require current owner membership and permission to manage the
routine. They check saved access changes and their applied permission records.
Routine history loads before the two-second write check, which watches only the
small member and silo ownership streams. The append checks the routine position.
No conversation history enters that check.

Retries check owner access and worker ownership before returning identifiers.
Access lost after saving also withholds the receipt. The saved event remains
available for an authorised retry. Broken history and denied access return the
same fixed refusal without private service details or run identifiers.

A late completion for an older run reuses the existing permission-history check.
It must match the original run binding before it can be ignored. The first outcome
stays unchanged. Old receipts and later claims remain available.
Execution is still disabled. No route, subscription, dependency or event type was added.

## Environment and commands

Linux and Node 22 in this worktree, with disposable NATS, OpenFGA and PostgreSQL
fixtures. This was not a fresh customer installation. Every lint, typecheck and
test command ran under `nice -n 10`; tests used `--maxWorkers=1`.

PostgreSQL used a throwaway `postgres:17.6-alpine` container with a random loopback
port. `pg_isready` passed before projection tests. The fixture connection was
`PG_TEST_URL=postgres://postgres:test-only@127.0.0.1:41131/postgres`.
The container and its volumes were removed with `docker rm -f -v` after testing.
The owner stack was not changed. No full root suite or live-view batch ran.

The three targeted Vitest runs covered:

- Run 1: `apps/ops/test/routine-due.test.ts`, `apps/server/test/routine-runs.test.ts`,
  `libs/authz/test/routines.test.ts` and `libs/events/test/security-rules.test.ts`.
- Run 2: the claim and run-list tests, plus `routines.test.ts` in `libs/authz`,
  `libs/events` and `libs/projections`.
- Run 3: the final claim fixtures and `routines.test.ts` in `libs/events` and
  `libs/projections`.

## Results

| Check | Result |
| --- | --- |
| Failing-first access proof | PASS: ten cases failed before the fix, including missing membership, removal, lost permission, revoked-worker retries and the removal race |
| Failing-first late completion proof | PASS: old-receipt recovery and a later claim both failed before the fix |
| Failing-first receipt proof | PASS: membership and permission revoked after append still returned identifiers before the fix |
| Targeted run 1 | PASS: 517 tests |
| Targeted run 2 | PASS: 87 tests |
| Targeted run 3 | PASS: 54 tests |
| Final claim fixtures twice | PASS: 46 tests in runs 2 and 3, including changed original run bindings |
| Run-list and routine suites twice | PASS: each requested file passed in two runs |
| Unchanged security rules once | PASS: 438 tests in run 1 |
| Typecheck | PASS: all workspaces and infrastructure, followed by a final ops check |
| Lint, including Knip | PASS: full command; zero code errors and 26 existing size warnings |
| Event catalogue | PASS: 154 event types agree |
| Changelog | PASS |

Logs are `/tmp/p4-24-pr8a-red-access.log`, `red-completion.log` and
`red-receipt.log`, with the same prefix on each file. The final test logs are
`validation-1.log`, `validation-2.log` and `validation-3.log` with that prefix.
Typecheck logs are `validation-typecheck.log` and `validation-final-ops-typecheck.log`.
The first lint scan found one complexity error. A named append-result helper fixed
it; the changed files then passed. The final full run passed in `validation-lint-final.log`.
Event and changelog logs are `validation-events.log` and `validation-changelog.log`.

## Remaining work

Full root suite, fresh-install live qualification, worker leases and ticks, execution,
activation, deployment and CI inspection: NOT RUN. Scheduled routine capability
remains PARTIAL. This source check does not make routine execution available.
The branch returns to the orchestrator after pushing, without waiting for CI.
