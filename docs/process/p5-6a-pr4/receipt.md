# Verified scanner launch

Part of #15. This change adds the separate database launcher. Current uploads
keep their existing scanner path.

- PASS — failing-first commit: all 18 initial launch tests failed because the
  launcher was absent.
- PASS — disposable ClamAV configuration smoke: the daemon started as `clamav`
  with a read-only root, no capabilities and no network, and answered a local
  ping. The temporary container and its volumes were removed.
- PASS — real Docker refused both an in-container write and a host copy into the
  read-only database directory. Only the disposable test container was removed.
- PASS — 83 launch/release/refresh tests twice, plus 438 security-rule tests.
  All suites ran under `nice -n 10`; security rules had the requested database URL.
- PASS — every lint stage, including Knip and changelog, plus typecheck and
  `check:events`. Documentation spacing was fixed and rechecked.
- PARTIAL — the smoke check used the existing local image and old databases.
  It checks configuration only, not approved release startup or freshness.
- NOT RUN — live launch with fresh reviewed image and manifest inputs. Those
  inputs were unavailable. Fixture updater evidence cannot qualify live scans.
- NOT RUN — HTTPS, issuance, per-scan expiry, consumers and fresh-install
  clean/EICAR/two-silo qualification. These remain later work.

## Startup deadline fix, 25 October 2026

Source: main `420523be9811ce3ff8f6ffb90fcf6e69d7302c96`, test commit
`579924e7b` and the deadline fix committed with this receipt. The test commit was
rebased from `0dfe04896`, where the failing-first run took place. Environment:
existing Linux x86_64 worktree, Node 22.23.3; no fresh install.

- PASS — rebased onto the fetched `origin/main` and confirmed it is an ancestor.
- PASS — failing-first tests reproduced the deadline bug: 15 failed and 57 passed
  before the fix. The tests were committed before the behaviour changed.
- PASS — launch and release suites passed twice, 72 tests per run. One
  run also covered refresh and security rules: 538 tests across four files.
  Slow Docker fixtures cover cumulative delays, every startup operation and
  refusing further work at the exact deadline. Cleanup retains its separate
  30-second limit per container.
- PASS — `check:events`: all 153 event types agree. Standalone changelog lint passed.
- PASS — repository typecheck, including every workspace and both infrastructure checks.
- PASS — every repository lint stage, including Knip, documentation, licences and
  changelog. ESLint reported 25 warnings in unchanged code and no errors.
- PASS — repeated all required checks after main advanced and the branch was rebased again.
- NOT RUN — full root suite and fresh reviewed live launch during this fix.
  These fixtures do not qualify live scanner startup or scanning.

Tests ran with `PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`,
`nice -n 10` and one worker. Safe local logs are
`/tmp/p5-6a-pr4-red.log`, `/tmp/p5-6a-pr4-green1.log` and
`/tmp/p5-6a-pr4-green2.log`. Logs after the final rebase are
`/tmp/p5-6a-pr4-final-tests1.log`, `/tmp/p5-6a-pr4-final-tests2.log`,
`/tmp/p5-6a-pr4-final-lint.log` and `/tmp/p5-6a-pr4-final-typecheck.log`.
Lint and typecheck also ran under `nice -n 10`.
