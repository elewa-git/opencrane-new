# Authenticated upload scans over HTTPS

Part of #15. Base: `f85834091`. This adds a separate service wrapper around the
owned scanner. Deployed issuance and upload/image consumers remain later work.

- PASS — `npm ci`, with the requested NATS and Lychee tool symlinks.
- PASS — test commit `396e38b41` came first. All 28 initial TLS cases failed
  because the service module was absent. A later header-delay probe also failed
  before the deadline included header receipt.
- PASS — real TLS and ES256 fixtures exercise trusted and refused connections,
  caller bindings, byte changes, expiry during transfer/scan, copied success,
  separate results, cancellation, a shared deadline and retirement.
  The fixture runs the existing scan operation with process replies, not ClamAV.
- PASS — the final service/launcher suite passed 97 tests twice. Earlier runs
  passed 534 tests with security rules, and 140 with scanner-token tests.
  After removing a test-only undeclared import, all 32 TLS cases passed twice again.
- PASS — all 17 JSON metadata/result field names pass the exact unchanged
  `RISKY_FIELD_NAME` expression. Passes travel only in the established HTTP
  authorisation header. No event fields, dependencies or authority checks changed.
- PASS — full lint, typecheck, Knip, event catalogue and standalone changelog
  checks. Lint includes licence checks and reported 25 warnings in unchanged code.
- NOT RUN — full root suite, production issuance, consumer journeys, fresh
  clean/EICAR and two-silo deployment. This admits no production upload.

Tests used `PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres` and
one worker, under `nice -n 10`. No projection suite, stack or model call was needed.
Safe logs are `/tmp/p5-6a-pr6-*.log` on the build host.
