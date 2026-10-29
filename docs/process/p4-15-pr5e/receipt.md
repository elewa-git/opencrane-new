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
