# Private proxy caller checks

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
