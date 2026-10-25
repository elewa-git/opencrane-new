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
