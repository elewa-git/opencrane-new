# Company account opt-in

Part of #49. This change records an admin choice for one exact installation.
It grants no access and stores no credential. Company account use remains unavailable.

- PASS: dependency installation and local test-tool links prepared.
- PASS: the first test commit (`a31258c97`) failed because the new module was absent.
  The command was added after that commit.
- PASS: 33 company command/fold tests and 308 event examples, each twice.
- PASS: 438 security-rule tests once; new names pass the exact risky-field matcher.
- PASS: registry and catalogue agree on 154 event types.
- PASS: full typecheck, knip and changelog checks.
- PASS: lint stages. The full code scan found one error in an earlier file version.
  The corrected files pass their final scan; all remaining lint stages pass.
- NOT RUN: full root suite and fresh-company qualification.

The command checks current admin membership after loading saved history. Removal
wins over history errors. It uses one conditional append and returns the original
receipt on an exact retry, including beyond broker deduplication. Re-registration
requires new opt-in even when the connection id is reused. Old replayed events cannot
restore a removed choice. Replay makes no network requests or appends.

Tests cover ordinary and foreign members, actor overrides, stale positions,
missing/replaced installations, membership removal during preparation and append,
expired access checks, lost replies, changed retries and synthetic secret markers.
The existing personal selection and dispatch paths still refuse company account use.
Tests use disposable NATS, OpenFGA and PostgreSQL fixtures under `nice -n 10` with
one worker. No model or provider calls were made. External spending: 0 euro cents.
