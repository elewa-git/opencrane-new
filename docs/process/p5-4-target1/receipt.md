# Isolated local target source checks

Date: 25 October 2026. Part of #15, P5-4 PR 3a.
Source: `c3fa075282b44a2715437281f9860158ab0429dc`, based on `489bfe66d`.
Failing-first test commit: `7b3fac95f`.
Environment: separate worktree, fresh `npm ci`, command fixtures with temporary homes.
No live target, development stack, model call or owner-stack change was made.

| Check | Result | Observed result |
| --- | --- | --- |
| Failing-first target fixtures | PASS | All ten new tests failed against the original launcher. |
| Changed tests, twice | PASS | All 33 claim tests passed in each final run. |
| Typecheck, event catalogue, Knip and changelog | PASS | Each command exited successfully. |
| `npm run lint` | PASS | Code, dependencies, docs, links, fixtures, licences and changelog passed. |
| Event security rules | PASS | All 438 tests passed. |
| Live target creation and three-node placement | NOT RUN | Reserved for p5-4-live1. |
| Preparation, bootstrap and browser integration | NOT RUN | Reserved for PR 4. |

The command fixtures exercise saved ownership before creation, a dead launcher
older than 15 minutes, an absent package namespace, dependency uncertainty,
resource replacement, partial creation, checked package context and confirmed
removal. They also check private output handling and command time limits.
Commands: `node --experimental-strip-types --test infra/dev-stack/claim.test.ts`
(twice), `npm run typecheck`, `npm run check:events`, `npm run lint:unused`,
`npm run lint:changelog`, and `npx vitest run libs/events/test/security-rules.test.ts
--maxWorkers=2`. Tests, lint and typecheck used `nice -n 10`. The security check
used the supplied `PG_TEST_URL`. The full root suite was NOT RUN.
These are source checks, not evidence that Kubernetes placed real workloads.

The target uses three 768 MiB nodes. Each receives a one-CPU limit after k3d
creation returns and before readiness. Initial or interrupted k3d startup CPU is not capped.
No creation-time CPU-cap guarantee is claimed. The owner-plus-two slot limit stays
unchanged. The live task must establish whether this fits the shared machine.

## CI fixture repair, 25 October 2026

Source: `373df6dc402ddb33eddffeca2db30170cd5385fc`, rebased onto
`170bc4d4afb02496914c87893c1a8fc0fd4dfe03`. The rebase completed and that main
commit is an ancestor of the tested source. The worktree uses Node 22.23.3.
No live target or development stack was started. The tests use temporary homes,
command fixtures and Chromium pages served by test fixtures.

The [failed checks job](https://github.com/elewa-git/opencrane-new/actions/runs/40192603457/job/121166695037)
could not load `target.ts` in two test fixtures. The gateway fixture now supplies
the target connection and checks its context and private kubeconfig on every
kubectl call. The runner fixture copies the real target module into its temporary
worktree. All existing IP, ownership, memory and no-write assertions remain.
Production code did not change. The first new commit contains only fixture fixes.

Before the fix, the focused command failed all seven selected cases with missing
module errors. After the fix, all seven passed. The printed company-limit failure
line is deliberate test output; it is not a failed assertion.

Checks use `nice -n 10`. The infra commands receive
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`. The infra scope is both
test commands in the [CI checks job](../../../.github/workflows/ci.yml): all 42
provider/package files, followed by the two browser files with concurrency one.
The full root suite and live target qualification remain NOT RUN.

| Check | Result | Observed result |
| --- | --- | --- |
| Infra pass 1 | PASS | All 371 provider/package and 9 browser tests passed; no skips. |
| Infra pass 2 | PASS | All 371 provider/package and 9 browser tests passed; no skips. |
| `npm run typecheck` | PASS | All workspaces and both infra projects passed. |
| `npm run check:events` | PASS | All 153 event types matched the catalogue. |
| `npm run lint:unused` | PASS | Knip exited successfully. |
| `npm run lint:changelog` | PASS | The release-note fragment passed. |
| `npm run lint` | PASS | Code, dependencies, docs, links, fixtures, licences and changelog passed. |

The local logs are `/tmp/p5-4-target1-infra-pass-1.log`,
`/tmp/p5-4-target1-infra-pass-2.log`, `/tmp/p5-4-target1-typecheck.log` and
`/tmp/p5-4-target1-lint.log`.
