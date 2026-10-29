# Deployment memory collector: own checks

Part of #97, P4-15 PR 5e. Branch: `work/p4-15-pr5e`.
Base: `2b21b63b4`. Test-first commit: `217e0a9fb`.
The initial test suite failed because the implementation module was absent.

PASS: 73 collector tests twice, 460 unchanged event-security tests once,
collector TypeScript and ESLint checks, catalogue (157 types), changelog,
all 19 output field names against the unchanged security rule, and CLI refusal
of invented input. Tests use a fixture at the Docker process boundary.
The CLI refusal starts no Docker command. No actual deployment qualified.
PASS: workspace lint, workspace typecheck and Knip.

Commands use `nice -n 10`: `npm run lint`, `npm run typecheck`, `npx knip`,
`npm run check:events`, `npm run lint:changelog`, the collector commands in its
[README](../../../scripts/private-memory-qualification/README.md), and
`npx vitest run libs/events/test/security-rules.test.ts --maxWorkers=1`.
Vitest used the supplied `PG_TEST_URL`; these tests do not use PostgreSQL.
PASS: `npm ci` and the requested tool symlinks. No dependency changes.

NOT RUN: live image/host qualification, the full root suite and both complete
private-turn/memory journeys. P4-15 PR 5d must supply the fixed image-owned journey
runner and run it on a fresh claimed deployment. Docker collection is implemented;
Kubernetes collection is outside this first part. Admission remains off.
No stack, model call, authority change or production receipt was made.

## Target selection and process cleanup, 29 October 2026

Source: `74996fdbce51b8b362717c1952470b3943151cfa`.
The fetch and rebase completed; `origin/main` at `2b21b63b4` is an ancestor.

Test-first commits: `b5b2b4b28` and `f9eeb7428`. Before the fixes, the other-silo
fixture returned PASS and the Docker cancellation tests left the journey and its
children running. These were expected regression failures. Target selection now
comes from a protected deployment-owned file. An in-container supervisor stops
the process group and prevents retries until its running members have stopped.

PASS: 85 collector tests twice, using one worker and the supplied `PG_TEST_URL`.
The six Docker tests cover the real two-minute timeout, stdout and stderr overflow,
collector SIGTERM and SIGKILL, and successful completion with children still running.
They confirm that the child and grandchild started, then are gone. Timeout,
overflow and success assertions check immediately after the collector call returns. Concurrent retries
refuse without starting; a retry after cleanup succeeds. Each fixture is removed
with `docker rm -f -v`. No application deployment was started or qualified.
PASS: collector typecheck and lint, check:events (157 types), Knip, lint:changelog,
and CLI refusal of a caller-selected target. All checks ran under `nice -n 10`.

NOT RUN: the full root suite and live memory journeys. Admission remains off.
PASS: workspace lint and workspace typecheck. ESLint reported zero errors and
34 existing warnings about function length.
