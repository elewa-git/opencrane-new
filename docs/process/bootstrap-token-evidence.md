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
