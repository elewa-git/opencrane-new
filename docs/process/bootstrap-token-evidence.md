# First-owner bootstrap evidence (#12)

Date: 4 October 2026. Source: branch `work/bootstrap-token`, based on
`39fe9da`. Environment: this isolated worktree; disposable local service fixtures,
control PostgreSQL 17 at port 55432. No dev or production stack was operated.

- PASS: the CLI prints one 256-bit random token, stores only its hash, silo and
  24-hour expiry at mode 0600, and refuses an existing credential file.
- PASS: the HTTP claim records one `silo.owner_bootstrapped` event through real
  NATS. Reuse after restart/removal, expiry, wrong token, pre-existing dev owner,
  wrong organisation (including a dev exception), invalid body and hostile Origin
  are refused. Two independent HTTP servers racing the same token produce one
  durable owner. The installation attempt budget refuses the sixth request and
  resets after one minute using an injected clock.
- PASS: real PostgreSQL projects and rebuilds the identity binding; real OpenFGA
  grants Owner/Admin and model use. Assistant and grant reactions are idempotent,
  and OpenFGA replay matches the live tuples. The existing model budget writer
  records the installation default paying group.
- PASS: Chromium claim journey at 1280px and 390px, keyboard submission,
  token clearing, refusals and successful ownership. Screenshots are written to
  `/tmp/bootstrap-claim-1280.png` and `/tmp/bootstrap-claim-390.png`.
- PASS: typecheck, event catalogue (83 types), Angular production build and all
  56 Angular tests. Existing bundle/CSS budget and noVNC warnings remain.
- PASS: final repository lint, including dependency direction, unused code,
  Markdown, links and fixture checks; final typecheck covers every workspace.
- FAIL: first full root run, `PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres npm test -- --maxWorkers=2`:
  1,362 passed, 14 skipped, one existing MCP discovery test exceeded the runner's
  five-second default timeout under host load. That test passed in isolation.
- PASS: complete root rerun, `PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres npm test -- --maxWorkers=2 --testTimeout=15000`:
  77 files passed, three skipped; 1,363 tests passed, 14 skipped. This changes the
  runner's default test timeout only. Application deadlines and assertions stay
  unchanged. All 17 bootstrap tests passed, including the browser journey.
- NOT RUN: the 14 opt-in root tests skipped by their existing live/provider flags;
  no skipped condition is claimed to pass.
- NOT RUN: fresh production installation and real Zitadel token claim. The user
  prohibited operating stacks. Production secret-file provisioning and ingress
  rate limiting across multiple replicas require live qualification.
- FAIL: independent review pass 1 found that an existing non-owner member could
  claim the token, receive a second active membership and lose identity access.
  The fix and verification are recorded below. The earlier no-blocker claim was
  incorrect.
- NOT RUN: ownership transfer (#24); outside this feature.

Repeat the tests using the commands in the [server contract](../../apps/server/README.md#first-owner-bootstrap-12).
The first HTTP tracer failed with 404 before the route existed; the first browser
tracer failed because the Claim this silo heading did not exist.

## Review pass 1 correction

Date: 4 October 2026. Base: `b2b371c`, with this correction on
`work/bootstrap-token`. Environment: the same worktree and PostgreSQL control
database; disposable NATS/PostgreSQL fixtures only. No stack was operated.

The #12 token admits the first owner of a fresh silo. The chosen rule refuses
all membership history, including invitations and removed members, rather than
promoting an existing member. Identity bindings live on member streams, so the
single append requires expected sequence zero across `member-*`, including the
claimant's binding stream. This also fences concurrent trusted provisioning.

- PASS: the new HTTP regression failed first with HTTP 201 instead of 409.
  After the guard, it returns `members_exist`, appends no event and preserves
  the original identity binding and member role through projection and replay.
- FAIL then PASS: deterministic races admit a non-owner after the claim's history
  read, before its append. Both the bound identity and an unrelated claimant
  initially received HTTP 201. The native category sequence expectation now
  refuses both without a bootstrap event; a retry reports `members_exist`.
- PASS: repository lint, all-workspace typecheck, event catalogue (83 types),
  web production build and web tests (11 files, 56 tests). Existing bundle/CSS
  budget and noVNC warnings remain. Command logs are in
  `/tmp/bootstrap-review-{lint,typecheck,web-build,web-tests}.log`.
- PASS: `PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres npm test -- --maxWorkers=2`
  with the default test timeout: 77 files passed, three skipped; 1,366 tests
  passed, 14 skipped, in 1,123.82 seconds. All 20 bootstrap tests passed,
  including the browser journey. Log: `/tmp/bootstrap-review-root-tests.log`.
- NOT RUN: the 14 existing opt-in tests skipped by their live/provider flags.
- NOT RUN: review pass 2 and fresh-install qualification. Stacks remain untouched.

## Final qualification round

Review pass 2 is LAND at `a3ef79c`, as supplied by the owner. The rebase completed
without conflicts. The [secondary live receipt](bootstrap-live/README.md) records
the completed fresh-install journey, screenshots and current source checks after
the orchestrator restored host forwarding. Historical NOT RUN entries above
describe their earlier runs.

The fresh secondary bootstrap journey is PASS, including stub chat, token reuse
and `members_exist`. The final complete root suite is FAIL: 1,365 passed,
14 skipped and one live-view authority assertion failed. That test also failed
in isolation. Source readiness remains blocked; the receipt contains both logs.

## Admission read scheduling repair

Date: 4 October 2026. Base: rebased `6287a38`, on `origin/main` `7b8b1d3`
(uploads #79), plus this repair. Environment: this worktree, Node 22.23.3,
existing PostgreSQL at port 55432 and disposable test fixtures. No installation
or host networking settings were changed.

Comparing `561a405` with main found no extra bootstrap read in this fixture's
admission path. It uses ordinary joined members and has no membership-route
configuration. The live-view flow and its event-store read implementation were
unchanged. Two initial isolated runs passed, then an instrumented whole-file run
reproduced allowed authority replies taking 1,203–1,230 ms, beyond the unchanged
1,200 ms deadline. The refusal came from read timing, not a missing owner grant.

Member history, conversation permission and desktop authority now run together.
The saved computer id starts a fresh desktop permission read alongside live
computer history. The live result must match that permission target; otherwise
we check the new desktop. Grant history, membership, participation, lifecycle,
permissions and history continuity must all pass. No permission result is cached.
The original slow-read test's assertions and deadlines are unchanged.

The added HTTP replacement-desktop regression returned 200 instead of 403 when
the target-match guard was temporarily removed. Restoring it refused the new
desktop until its own grant reached OpenFGA, then admitted it. The final focused
run passed that case and the slow-read case; its whole-file result was FAIL due
to a separate NATS `head()` timeout also reproduced before the repair.

- FAIL: complete root run with default timeouts: 1,393 passed, five failed and
  14 skipped. All 12 live-view tests passed. Uploads lacked the newly required
  `ocn-upload-computer:test` image; three unrelated cases exceeded Vitest's
  five-second default, and the Chromium chat command exceeded its 180-second
  process limit during shared-host load.
- PASS: `sh scripts/build-test-computer.sh` prepared the documented uploads #79
  prerequisite from public pins, without starting an installation.
- PASS: complete root rerun, 79 files passed and three skipped; 1,398 tests
  passed and 14 skipped, in 1,065.44 seconds. Command:
  `PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres npm test -- --maxWorkers=2 --testTimeout=20000 --reporter=verbose`.
  This adjusts only the default runner timeout. The original slow-read test's
  explicit 30-second timeout and all application deadlines remain unchanged.
  All previously failing upload, wake, chat, bridge replay and Chromium cases
  passed. [Safe root and live-view result](bootstrap-live/admission-repair-tests.txt).
- PASS: final repository lint, all-workspace typecheck and `check:events`
  (86 event types). All 60 Angular tests passed in 11 files, and the production
  web build passed. Existing lint and build warnings remain.
- PASS: the rebase completed onto `7b8b1d3`; no rebase state remained and
  `origin/main` was an ancestor. Range comparison retained all three bootstrap
  commits and the upload documentation, routes and event exports.
- NOT RUN: the 14 opt-in conditions skipped by the root suite; fresh-install
  qualification of this scheduling repair. The earlier live bootstrap receipt
  describes its own source and environment.

Safe full local logs: `/tmp/bootstrap-final-{root-tests,lint,typecheck,events,web-tests,web-build}.log`.
The default-timeout failure is retained at `/tmp/bootstrap-default-root-tests.log`.
