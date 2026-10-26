# Private proxy caller checks

The checks below describe the original implementation and the later grant fix.
The final section records the added grant-selection tests against the rebased source.

Date: 26 October 2026. Part of #97. Base: `12ca064d74866818c81a296046f4703e69fe306d`.
Failing-first test commit: `189f56584`.
Implementation source: `bdd3e2fa26fe7a61e8a7a72ac58a68537ce19565`.

This is the proxy part of the requested change, split at the 600-line target.
It adds in-process registration and checks model requests and restricted catalogues
against separate caller identities. The production supervisor and bridge do not yet
use this registration. Their shared caller remains a known gap. Memory admission
stays disabled, and this receipt does not claim private process isolation.

Prerequisites were merged before this work started:

- PR 3a, #710: `7235079d9`.
- PR 3b, #715: `955cfedca6466d27b14f07b82be46d4ebf3a7523`.
- PR 3c, #722: `12ca064d74866818c81a296046f4703e69fe306d`.

The environment is a clean worktree install on Linux with real loopback and Unix
sockets, local fixture replies and a newly built Docker image. No owner stack,
secondary stack, real model call or full root suite was used. Tests, builds, lint
and typechecks run under `nice -n 10`. Targeted tests set the supplied `PG_TEST_URL`
on port 55432; none of the selected tests requires projection database setup.

## Own checks

- PASS: `npm ci` and the requested NATS and Lychee links.
- FAIL, expected: all 13 initial tests failed because registration did not exist.
- PASS: those 13 tests after implementation.
- FAIL: the first expanded run passed 85/86. A body-reading test sent Stop before
  the HTTP request arrived. Waiting for HTTP 100 Continue made the ordering explicit.
- PASS: 524/524 tests across private proxy, MCP proxy, thread load lifecycle,
  proxy Stop and the unchanged event-security rules.
- PASS: final 87/87 tests in the four proxy/lifecycle files, twice.
- PASS: 10/10 existing bridge-credential and private-launch tests with the new image.
  These include credential rotation, protected files and disabled debugger entry.
- PASS: full workspace/infrastructure typecheck and final computer typecheck.
- PASS: `check:events` (154 types), separate Knip and `lint:changelog`.
- PASS: a fresh image build, exact source-content checks, 92 installed notice files
  collected and 385/385 packages accepted by the image licence checker.
- PASS: full lint, including dependencies, Knip, docs, links, fixtures, package
  licences and changelog. Code lint reports 26 warnings and zero errors.

The final local image is `ocn-computer-p4-15-pr4a`, digest
`sha256:45e9a4301406c2b394dab5b0b4e08105d2823c14e95b7831a790f387c42a8d11`.
It uses the pinned local `s035` base and this checkout's Dockerfile. The build and
licence commands are the existing image checks, without registry publication or
cluster journeys. The fixture image was used only in disposable Docker containers.

Tests check two callers in one conversation, guessed private addresses from the
ordinary caller, cross-turn discovery and calls, changed identity, expiry, Stop,
closure, replacement, fixed discovery before binding, in-flight requests and a lost
grant acknowledgement. They check that private callers stay out of the ordinary
caller file and refusal replies. No new event or public API field is added. The
local generation fields were checked against the exact `RISKY_FIELD_NAME` expression.
That file and both protected authority test files remain unchanged.

## Remaining work

PARTIAL: proxy enforcement only. Trusted supervisor authentication, fresh per-process
launch delivery, private thread catalogue loading, binding to the server's input
and computer generations, automatic invalidation and replacement wiring remain
pending. The supervisor/bridge must close registrations on every uncertain launch
or exit; this part tests the proxy's close operation directly. No public minting
route or memory tool is introduced. Existing bridge credential rotation is unchanged.

NOT RUN: gVisor, native recall, a fresh-install journey, live private caller delivery,
private caller protection from desktop/tool users and PVC outbox checks with those
new callers. Old image receipts do not qualify these bytes. No release image or
running computer is updated by this source-only part.

Safe local logs use `/tmp/p4-15-pr4a-` with `red.log`, `tests-2.log`,
`final-tests-1.log`, `final-tests-2.log`, `image-build.log`, `image-checks.log`,
`image-tests.log`, `image-checks-final.log`, `lint.log`, `typecheck.log` and `checks.log`.

The repeated targeted command was:

```sh
PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres nice -n 10 npx vitest run apps/computer/test/private-proxy.test.ts apps/computer/test/mcp-proxy.test.ts apps/computer/test/thread-load-lifecycle.test.ts apps/computer/test/turn-stop.test.ts --maxWorkers=1
```

## Grant and thread checks — 26 October 2026

Source: `65530cc75`. Base: `b36019eba4f4add1cb77466a7417843b3ee0a787`.
The rebase completed, the base is an ancestor of this branch and no rebase is pending.

Every tool call now checks the caller against the grant it will send. Approval
retries repeat that check after renewal. Binding a private caller refuses a thread
with an ordinary catalogue or another turn's grant before recording the binding.
The existing checks still refuse ordinary work on a bound private thread. Ordinary
turns can still reuse their thread and catalogue.

Failing-first commits: `cb4abe3a8` for borrowed grants and `935814db1` for conflicting
bindings. Both call regressions failed by forwarding and returning the fixture's
private result. Both new binding regressions failed because binding succeeded.
These tests use the real loopback proxy and Unix control socket.

Own checks:

- PASS: 176 tests in 13 computer proxy, turn runner and lifecycle files, twice.
- PASS: 9 memory bridge-loss tests, twice, with real NATS and a throwaway PostgreSQL
  17.6 container. The container and its volume were removed after the tests.
- PASS: all 438 tests in the unchanged `libs/events/test/security-rules.test.ts`, once.
- PASS: `check:events`; all 154 event types agree.
- PASS: typecheck for every workspace and both infrastructure projects.
- PASS: full lint, including dependency checks, Knip, docs, links, fixtures,
  package licences and `lint:changelog`. ESLint reported 26 warnings and zero errors.

The initial borrowed-grant call sends zero upstream requests. The approval case
sends only the first request needed to obtain the approval refusal, then sends no
retry. Neither returns the fixture's private result. Conflicting bindings are tested
in both orders; refusing a conflict leaves the valid caller working.

All test and check commands run under `nice -n 10`; tests use one worker. Computer
and event tests use the supplied `PG_TEST_URL` on port 55432. The projection test
uses its own disposable PostgreSQL container on port 41442, as required by the test
setup rules. No owner stack or secondary stack was touched. No full root suite ran.

Logs use `/tmp/p4-15-pr4a-fix1-` with `red-calls.log`, `green-calls.log`,
`red-bindings.log`, `green-bindings.log`, `tests-1.log`, `tests-2.log`,
`memory-1.log`, `memory-2.log`, `security.log`, `events.log`, `typecheck.log`
and `lint.log`.

PARTIAL: private process launch integration remains pending. Memory admission stays
disabled. NOT RUN for this fix: a new image build, native recall, gVisor and a fresh
install journey. The earlier image checks do not qualify the changed source.

## Grant-selection regression coverage — 26 October 2026

Test source: `f3fc7ae94d9295a89770e214cf478c767a9bedb2`.
Base: `7fb7303993b8223fd18b512e2407d6f76908877d`.
PASS: fetched origin, completed the rebase and checked that this base is an ancestor
of the branch, with no rebase still pending. Production code is unchanged by this fix.

The earlier socket tests stop at binding or renewal. Four new cases call the real
MCP handler through loopback HTTP, with a grant map and a separate caller decision.
This lets each case reach grant selection without an earlier binding refusal.
Both ordinary and restricted catalogues are covered before the first forward and
after successful approval renewal. The tests check the selected grant's turn and
thread, no private result, and zero forwards from the refused operation. Approval
cases also assert exactly one initial request and a successfully installed new pass.

Each temporary mutation ran separately and was restored. The tests failed on both
unexpected forwards and delivery of the fixture's private result:

| Mutation | Initial ordinary | Initial restricted | Retry ordinary | Retry restricted |
| --- | --- | --- | --- | --- |
| Remove the actual-grant caller guard | FAIL, expected | FAIL, expected | FAIL, expected | FAIL, expected |
| Replace only the initial call's caller decision with `allowTurn` | FAIL, expected | FAIL, expected | PASS | PASS |
| Replace only the retry's caller decision with `allowTurn` | PASS | PASS | FAIL, expected | FAIL, expected |

PASS: all three mutations are detected. The unaffected cases stay green when only
the other call path is changed. No production mutation remains.

Own checks on Linux, with local fixture services rather than a fresh install:

- PASS: 93 tests in private proxy, MCP proxy, proxy Stop and bridge proxy, twice.
- PASS: `check:events`, with 154 event types agreeing.
- PASS: separate Knip and `lint:changelog` checks.
- PASS: typecheck for every workspace and both infrastructure projects.
- PASS: full lint, including documentation, links, fixtures and package licences.
  Code lint reported 26 existing warnings and zero errors.

The repeated test command was:

```sh
PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres nice -n 10 npm test -- apps/computer/test/private-proxy.test.ts apps/computer/test/mcp-proxy.test.ts apps/computer/test/turn-stop.test.ts apps/server/test/bridge-proxy.test.ts --maxWorkers=1
```

All checks ran under `nice -n 10`. Tests used one worker and the supplied
`PG_TEST_URL`; these files do not run projection tests. No full root suite ran.
No owner stack or secondary stack was touched.

Logs: `/tmp/p4-15-pr4a-fix2-{tests-1,tests-2,events,knip,changelog,typecheck,lint}.log`.
Mutation logs: `/tmp/p4-15-pr4a-{guard-removed,initial-use-removed,retry-use-removed}.log`.

PARTIAL: private launch integration remains pending and memory admission stays
disabled. NOT RUN: a new image build, native recall, gVisor or fresh-install journey.
CI is not awaited for this push.
