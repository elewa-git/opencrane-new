# Routine leadership source checks

Date: 4 November 2026. Part of #106, P4-24 PR 8b.
Base: `cf809dada`. Test-first commit: `e8db29d92`.
This change supplies the first worker part of accepted design row 8.

The helper holds a separate PostgreSQL session lock for routine preparation.
It checks that same session before claims and while preparation waits. Shutdown,
query failure and connection loss cancel its signal. Old checks stay refused
when another session takes over. The callback must stop and await its work;
the helper drains pending checks before releasing the session.

`routine-due.ts`, both authority test files and the security rules are unchanged.
No worker registration, queue, scan, skip/missed writer, sender, enable switch,
event, dependency or money field was added. Company execution remains blocked.
The new option and callback field names pass the existing risky-name substring rule.

## Local evidence

`npm ci` completed. NATS and Lychee use the requested local binary symlinks.
Tests use a throwaway PostgreSQL 17.6 container, disposable NATS and OpenFGA.
`PG_TEST_URL` names only that test database. Lint, typecheck and tests run under
`nice -n 10`, with one test worker. No development stack or model call was used.

The initial test failed because the helper did not exist. After the first passing
ownership test, terminating the held PostgreSQL session exposed missing callback
cancellation. That test failed before the background session probe was added.
Logs are in `/tmp/pr8b-*.log` on the builder host.

| Check | Result |
| --- | --- |
| Test-first proof | PASS: missing helper and missing session-loss cancellation failed first |
| PostgreSQL/NATS/OpenFGA regressions and unchanged security rules | PASS: 518 tests |
| Final leadership tests | PASS: 13 tests twice |
| Wake, model, tool and broker calls | PASS: all spies stayed unused |
| Typecheck | PASS: all workspaces and infrastructure; final ops check also passed |
| Event catalogue | PASS: 158 event types agree |
| Knip, dependency, documentation, README and offline link checks | PASS |
| Fixture, licence and changelog checks | PASS |
| Full lint command | PASS: code and all remaining lint steps |

The final leadership runs are `final3.log` and `final4.log`. The combined regression
run is `targeted1.log`. No unhandled promise work was reported. The throwaway
database and its volume were removed after testing.
The initial full lint scan was stopped near Node's default memory limit. The final
full run passed with a 6 GiB heap limit and `nice -n 10`; its log is `lint-final.log`.

## Remaining work

Full root suite and fresh-install live qualification: NOT RUN locally.
Automatic scheduling remains PARTIAL. Ticks, candidate scans, missed/skip records,
activation and company dispatch remain later work. The existing routines worker
only updates read tables.
