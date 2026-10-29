# Restore authenticated home bytes into disposable files

Date: 29 October 2026. Part of #15. Recovery: PARTIAL. Live: NOT RUN.
Base: `8b93ce3c1`. Failing-test commit: `eb4911932`.
Implementation: `13423ab161e937679ff8af54e7d4a6db18814629`.

## Scope

Accepted design: Phase 5 backup steps 4–6, P5-8/P5-9 and D06/D07/D09–D11.
This adds a separate byte restoration fixture using real disposable NATS archives,
the existing version-2 AES-GCM descriptor and the existing home validator.
Two distinct non-empty homes restore to newly registered private files. The helper
checks current deletion records before reading back those files. It never starts
replay, a reader service or an effect. The probes are exercised before checking zero calls.

Every home authenticates before any target write. Current source history, private
file identities, empty target identities and the original deadline are checked again
before delivery. Targets are bound to silo, attempt and the complete home identity,
including assistant, computer and generation. Plaintext and readback buffers are erased
on success, failure and cancellation. Uncertain writes leave files isolated without
retry, cleanup, reopening or a later writer. Only delivered bytes enter the result count.

## Own checks

PASS: `npm ci` and the requested NATS and Lychee links.
Expected FAIL: the initial real-archive regression authenticated both homes but
observed no delivery callback. The test was committed before implementation.
The first expanded run exposed fixture spies counting setup writes and retaining
mock implementations; the fixture now resets them and counts only target writes.
An initial package typecheck required an explicit target-array type; that was fixed.
Expected FAIL: cancellation queued after the first write initially allowed the second
home to be delivered. The writer now yields between bounded I/O chunks so cancellation
is handled before readback or the next home. Both regressions preceded their fixes.

PASS: 654 tests across the new home fixture, existing combined recovery and custody,
home export, coordinated capture and unchanged security rules. PASS twice: all 28 new
home cases, including cancellation and refusal to reuse the untouched second target.
The broader batch took 580.42 seconds; the two home runs took 80.40 and 102.70 seconds.
Security rules ran once.
The files and commands are listed in [checks.txt](checks.txt).

PASS: event catalogue (157 types), explicit Knip and changelog validation.
PASS: workspace typecheck and full lint, including links, fixture boundaries and
licences. Code lint reports zero errors and 33 existing size warnings. The separate
documentation check found one extra blank line; it was removed and the check passed.

Environment: Node 22.23.3, fresh disposable NATS processes and MinIO containers. The tests
use synthetic Kubernetes replies and private temporary files. `PG_TEST_URL` used the
supplied loopback fixture URL; these selected suites do not open a PostgreSQL database.
Every test, lint and typecheck command runs under `nice -n 10`. Vitest uses one worker
and disables file parallelism. No full root suite or dev stack runs. CI is not awaited.

## Limits

PARTIAL: this proves raw bytes in disposable files only. No archive extraction is
invented. Mounted filesystem restoration, live volume ownership, CNPG/WAL,
all-database recovery, a pinned-package upgrade, credential renewal, reopening and
fresh-install recovery are NOT RUN. No stack, model call or full root suite runs.
Images, preflight gates, chart settings, access code and protected tests are unchanged.
No dependencies, event types or API fields are added.
