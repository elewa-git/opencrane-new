# Scans through the owned daemon

Part of #15. Base: `e718e3e90`, including merged #692 and its deadline fix.
This is the first internal scan operation. HTTP, caller issuance and consumer
wiring remain later work. No dependency, event or admission rule changed.

- PASS — `npm ci` completed in this worktree. NATS and Lychee use the requested
  tool symlinks. No dependency manifest or lockfile changed.
- PASS — test commit `7e1b3fc2e` preceded implementation: 24 new scan cases failed
  because `scan()` was absent; all 34 existing launch tests passed.
- PASS — disposable TCP/process fixtures exercise real INSTREAM frames, exact
  byte hashes and counts, buffer copying, concurrent requests, malformed replies,
  expiry, stopped/replaced/restarted daemons, cancellation, TERM and failed cleanup.
  A cumulative-delay case refuses a late final check; another gives transfer only
  the 15 seconds left after inspection. Private canaries remain absent from results
  and fixed errors.
- PASS — 565 tests across launch, release, refresh and security rules passed.
  After the final container-ID change, all 62 launcher tests passed twice.
  A separate 128-test run also covered the unchanged release and refresh suites.
- PASS — repository typecheck, `check:events` (153 matching types), standalone
  changelog lint and diff checks. Internal result names also pass the unchanged
  exact `RISKY_FIELD_NAME` expression. Security and authority tests were not edited.
- PASS — the full lint command, including Knip, documentation, local links,
  fixture/licence checks and changelog. ESLint reported no errors and 25 warnings
  in unchanged code.
- PARTIAL — the real Docker transport smoke returned clean for a 34-byte fixture
  and infected for the 68-byte EICAR fixture. It used the existing local image and
  old databases, with fixture dates supplied only to exercise the transport helper.
  It did not bypass or qualify the launcher's approved-manifest checks.
- PASS — the smoke exposed ClamAV's need for temporary scan files. A bounded
  64 MiB memory-only `/tmp` fixes that path while the root and databases stay
  read-only. Temporary containers and their volumes were removed. No owner stack,
  host networking, Docker daemon settings or second daemon was touched.
- NOT RUN — fresh-database clean/EICAR and two-silo qualification, HTTP/TLS,
  issuance wiring and upload/image consumer journeys. No live completion claim.

Any failed request retires the entire handle, including concurrent requests.
Killing the Docker client cannot confirm that its remote process stopped, so
container removal remains necessary. Failed removal retains the ownership record
and blocks reuse. Recovery of a single failed request without retiring the daemon
is outside this slice.

Checks use `nice -n 10`; tests use one worker and
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`. No full root suite
or projection tests were run. Safe logs are `/tmp/p5-6a-pr5-red.log`,
`/tmp/p5-6a-pr5-green1.log`, `/tmp/p5-6a-pr5-final1.log`,
`/tmp/p5-6a-pr5-final2.log`, `/tmp/p5-6a-pr5-final3.log`,
`/tmp/p5-6a-pr5-smoke-final.log`,
`/tmp/p5-6a-pr5-lint.log` and `/tmp/p5-6a-pr5-typecheck.log`.

## Transport failure cleanup, 25 October 2026

Source: `bd69ee6d9380fd821e6cbb70bbe6a19fd3b4584e`.
Rebased onto `origin/main` at `11ed0475a09333a1eadcc603a8ce076679ae0e0c`;
the rebase completed and that base is an ancestor of this branch.
Environment: this existing worktree, not a fresh installation. Tests used disposable
TCP/process fixtures and fake children. No owner stack was changed.

A timeout, cancellation or oversized reply now stops the shared scanner as soon
as it is detected. Pending and new scans refuse before the failed Docker client
closes. The failed request waits for container cleanup and gives the killed client
up to 30 seconds to close. A missing close event cannot leave it waiting forever.

- PASS — failing-first test commit `ed9f10cc9`: all three new concurrent cases
  failed because another scan could still start after the transport failure.
  Test commit `749583feb` also requires the request to wait for bounded child
  cleanup. Those assertions failed before that wait was added.
- PASS — all 65 launcher tests passed twice. The second run also covered release,
  refresh and unchanged security rules: 569 tests across four files passed.
  The fake failing child never emits close, including after a timeout. New scans
  start no Docker process, the other pending transfer cannot return clean, and
  all requests refuse after cleanup. Existing child-exit assertions remain intact.
- PASS — full repository typecheck, event catalogue check (154 matching event
  types), standalone changelog lint and whitespace checks.
- PASS — full lint, including Knip, dependency rules, documentation, links,
  fixtures, package licences and changelog. ESLint reported zero errors and
  25 warnings in unchanged files.
- NOT RUN — full root suite and projection tests, as requested for this fix.
  Fresh-database clean/EICAR, HTTPS, issuance, consumer and live two-silo journeys
  remain unqualified.

Commands used `nice -n 10`. Tests used `--maxWorkers=1` and
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`.
The first test command selected `scripts/clamav-launch.test.mjs`; the second also
selected `scripts/clamav-release.test.mjs`, `scripts/clamav-refresh.test.mjs` and
`libs/events/test/security-rules.test.ts`. Repository checks used
`npm run lint`, `npm run typecheck`, `npm run check:events` and
`npm run lint:changelog`. The lint command includes `npm run lint:unused` (Knip).

Safe logs: `/tmp/p5-6a-pr5-fix-cleanup-red.log`,
`/tmp/p5-6a-pr5-fix-launch1.log`, `/tmp/p5-6a-pr5-fix-tests2.log`,
`/tmp/p5-6a-pr5-fix-typecheck.log` and `/tmp/p5-6a-pr5-fix-lint.log`.
