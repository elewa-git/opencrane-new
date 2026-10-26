# Claim one scheduled occurrence without starting it

Date: 26 October 2026. Part of #106.
Base: `690c2e44c`. Failing-first test commit: `dd007443c`.
Source: `04a4f9736f83a54b6ff09352c03317a419e9ab00`.
Environment: Linux, Node 22, this worktree and disposable NATS fixtures.
This records source checks, not a fresh customer installation.

## Change

An internal command reads the exact routine history before its short worker
ownership check. One conditional append claims the saved slot and freezes its
definition, owner, payer, revisions, run identities and start deadline. Retries
return the original record, including after later completed runs. They cannot
claim a consumed slot again after broker deduplication expires.
The command starts no work. Both the fold and receipt keep execution unavailable.
No route, event type, dependency, money field or subscription changed.
The dependency rule now recognises the calendar helper's existing public export.
The existing security field-name rule was checked without changing it or either
authority test file. Input and receipt names contain only approved identifiers
and metadata; private service errors are replaced with fixed errors.

## Checks

`npm ci` completed. The supplied NATS and Lychee binaries are symlinked locally.
All lint, typecheck and test commands use `nice -n 10`; tests use one worker.
The requested `PG_TEST_URL` is set. These focused tests use NATS and do not open
PostgreSQL. No development stack or model call was used.

| Check | Result |
| --- | --- |
| Test-first proof | PASS: missing command failed before implementation |
| Consumed-slot regression | PASS: reproduced a second append, then added refusal before append |
| History deadline regression | PASS: reproduced a late successful read, then added refusal |
| Changed tests twice | PASS: 24 tests in each final run |
| Unchanged security rules | PASS: 438 tests, run once |
| Lint, including Knip | PASS: full code scan and all remaining lint steps |
| Typecheck | PASS: all workspaces and infrastructure; ops checked again after the test tidy-up |
| Event catalogue | PASS: 154 event types agree |
| Changelog check | PASS |

Local logs use `/tmp/p4-24-pr8a-*.log`. The failing runs are `red.log`,
`guards-red.log` and `history-red.log`; final tests use `final-tests-1.log` and
`final-tests-2.log`. Security results are in `tests-1.log`; that combined run also
exposed a test-fixture parser error, fixed before both final command runs.
The first code scan read the earlier fixture errors. The final full code scan
in `lint-final.log` has zero errors and 25 existing size warnings. Its dependency
check exposed the missing calendar entrypoint rule. After that fix, configuration
lint and every remaining lint step passed in `lint-config.log` and `lint-remaining.log`.
Other logs are `typecheck.log`, `events.log` and `changelog.log`.

## Remaining work

Full root suite, fresh-install live qualification and CI inspection: NOT RUN.
Worker ownership implementation, lease, ticks, skip/missed recording, catch-up,
manual runs, activation and deployment remain later work. This command alone
does not make scheduled routines available. The draft PR returns to the
orchestrator without waiting for CI.
