# Bounded routine checks in member departure reviews

Date: 25 October 2026. Part of #106.
Base: `f858340914a3d411fc6e4cbf2d6703183787910d`.
Failing-first test commit: `b1ca2d116`.
Environment: Linux, Node 22, this worktree and disposable test services.
This is source validation, not a fresh customer installation.

## Change

Member reviews use the existing checked routine presence query. It reads one indexed
position instead of opening every routine stream. Empty, caught-up history can prove
absence. Modern, legacy and retired routines still block removal. Uncertain history
cannot enable removal. Routine position and rebuild generation bind the review and
its final check before a write. Connection and other inventory checks stay required.
The route checks current admin access once after preparation, including failures.
Departure cleanup keeps its routine references. Provider replies stay unchanged.
No event, public API field, dependency, routine count or firing path was added.
The existing security field-name rule was checked and left unchanged, along with
both authority test files. Removed a stray conflict marker from the affected
projection README diagram.

## Dependencies and design

Both dependencies were already on this branch's base:

- Routine presence helper, #708: `2d3cc1be0b385e061a50d2806deb539c43cfcb4a`.
- Shared models exports, #709: `f858340914a3d411fc6e4cbf2d6703183787910d`.

Read the accepted design, sections 1 and 4 and row 7, its repository copy,
the requested builder handoff and the verification notes for both dependencies.
Read the bounded-list verification and affected package contracts.

## Checks

`npm ci` completed. The worktree uses symlinks to the supplied NATS and Lychee tools.
Every lint, typecheck and test command used `nice -n 10`.
Full lint used `NODE_OPTIONS=--max-old-space-size=6144`.
Tests used `PG_TEST_URL` pointing to the owned disposable PostgreSQL container
`pgtest-p4-24-pr7b` on port 40010, plus their normal NATS and OpenFGA fixtures.
The owned PostgreSQL container and its volume were removed after the tests.

| Check | Result |
| --- | --- |
| Failing-first volume checks | PASS: both cases failed on the old payload-read path |
| Failing-first uncertainty, access and stale-review checks | PASS: 12 expected failures before implementation |
| Late routine insertion and rebuild | PASS: both failed before the final-ordering fix and passed afterwards |
| Final focused tests | PASS: 82 tests twice across four files |
| Provider, cleanup, projection and security regressions | PASS: 579 tests, including unchanged security rules |
| Gateway, chat and viewer removal callers | PASS: four selected cases, each passed twice |
| Lint, including Knip | PASS: full command, zero errors; existing size warnings remain |
| Typecheck | PASS: all workspaces, package and development-stack types |
| Event catalogue | PASS: 154 event types agree |
| Changelog check | PASS |

An early repeat timed out while preparing large fixtures. Routine volume fixtures now
commit their projection writes together. The member fixture runs the routine worker
when routine history changes. No production deadline or assertion was relaxed.
The first gateway caller attempt lacked its pinned test binary. The repository fetch
script installed it before the two passing runs.

Local command logs use `/tmp/p4-24-pr7b-*.log`.
The red logs are `red.log`, `red-guards.log` and `late-red.log` under that prefix.
Final runs use `final-tests-1.log`, `final-tests-2.log`, `regressions.log`,
`typecheck-complete.log` and `lint-verified.log`.

## Remaining work

Fresh-install live qualification, the full root suite and CI inspection: NOT RUN.
Routine counts, integration dependencies, removal ownership transfer and firing
remain later work. Execution stays disabled. The draft PR is handed back without
waiting for CI.
