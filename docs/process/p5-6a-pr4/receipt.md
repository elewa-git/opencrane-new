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
