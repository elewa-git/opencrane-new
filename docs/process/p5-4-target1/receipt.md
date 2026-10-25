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

## Failed target startup cleanup, 25 October 2026

The installed k3d has no option to set a CPU limit when it creates a node.
The launcher now removes the nodes and network from a failed start before it
returns an error. It checks the saved attempt ID and Docker resource IDs before
removal. If cleanup cannot be confirmed, it keeps the owner record for a later
retry. An abruptly killed launcher cannot run this cleanup; the recorded owner
still prevents another worktree from taking the slot.

The first new test failed before the fix: two running nodes remained after the
fake k3d created them and exited with an error. The corrected fixture also
checks that a failed CPU update removes all three nodes.

| Check | Result | Observed result |
| --- | --- | --- |
| Failed creation before the fix | PASS | The new test failed with two nodes left running. |
| Claim tests, twice after the fix | PASS | All 35 tests passed in both runs. |
| Typecheck and event catalogue | PASS | Both commands exited successfully; 154 event types matched. |
| Repository lint, including Knip and changelog | PASS | All lint steps exited successfully. |
| Live target creation and three-node placement | NOT RUN | Still awaits a fresh installation. |

The checks used `nice -n 10`. The repeated claim logs are
`/tmp/p5-4-target1-claim-review-pass1.log` and
`/tmp/p5-4-target1-claim-review-pass2.log`. The repository lint log is
`/tmp/p5-4-target1-review-lint.log`. The full root suite was NOT RUN.

## Private route identities on claimed targets, 25 October 2026

Source: `c912fb91d9135753b3437e022b6b6691587cbad9`, rebased onto
`7b0f48cc8d1e2570be2967b39b94be9bed50dd34`. The rebase finished. That main
commit is an ancestor of this source and includes the three-peer chart from
PR #691 and distinct route identities from PR #700.

Environment: Linux, Node 22.23.3, existing worktree dependencies and disposable
test homes. Helm renders the real chart, and the pinned NATS server parses each
peer's settings. Chromium uses test pages. No live install or owner-stack change
was made.

The route fixture did not copy the new `target.ts` dependency. All 17 existing
route tests failed before that repair. The repaired fixture uses the real target
module with disposable Docker and Kubernetes command fixtures.

Test commit `804a9f8d8` then showed a separate problem: route preparation failed
on a claimed target but passed on the existing local cluster. The Secret commands
omitted the target's private kubeconfig. Fix `3cd434cf5` checks the target again,
requires its context to match the package owner and supplies that private file
for every Secret read and creation. Certificate checks still require three distinct
peer keys, exact DNS names, both TLS usages, valid dates and a separate route issuer.
The refusal and retry assertions remain intact.

The first broad run found five claim-fixture failures because a live secondary
stack held port 25110. Commit `c912fb91d` gives those fixtures disposable sockets.
The occupied-model-port case still holds a real listener and requires slot 1 to
be refused. All five affected cases passed while the live stack still held its port.
Production port checks and the existing slot assertions remain intact.

Both complete infra commands come from the CI checks job and cover 46 files.
The first uses two files at a time; the separate browser command uses one.
All tests receive the supplied `PG_TEST_URL` and run under `nice -n 10`.
Lint and typecheck also run under `nice -n 10`.

| Check | Result | Observed result |
| --- | --- | --- |
| Route suite before the fixture repair | FAIL | All 17 existing cases failed. |
| Claimed-target regression before the production fix | FAIL | Target preparation failed; existing local-cluster preparation passed. |
| Broad run before socket isolation | FAIL | 388 tests passed and five claim cases failed; the following browser command was NOT RUN. |
| Focused socket-isolation check | PASS | All five affected claim cases passed. |
| Final infra pass 1 | PASS | All 393 provider/package and 9 browser tests passed; no failures or skips. |
| Final infra pass 2 | PASS | All 393 provider/package and 9 browser tests passed; no failures or skips. |
| Repository lint | PASS | Every step passed, including Knip, licences and changelog. |
| Typecheck | PASS | All workspaces and both infra projects passed; the dev-stack project passed again after its fixture change. |
| Event catalogue | PASS | All 154 event types matched. |
| Separate Knip and changelog commands | PASS | Both commands exited successfully. |
| Full root suite and live target qualification | NOT RUN | Outside this repair's test scope. |

Each final provider/package run includes all 18 route-preparation tests, all eight
chart tests and all 35 claim tests. The extra route case checks the existing local
cluster when no separate target is recorded.

Logs: `/tmp/p5-4-target1-routes-baseline.log`,
`/tmp/p5-4-target1-routes-red-focused.log`,
`/tmp/p5-4-target1-route-infra-pass1.log`, `/tmp/p5-4-target1-claim-ports.log`,
`/tmp/p5-4-target1-route-infra-final-pass1.log`,
`/tmp/p5-4-target1-route-infra-final-pass2.log`,
`/tmp/p5-4-target1-route-typecheck.log`, `/tmp/p5-4-target1-claim-typecheck.log`
and `/tmp/p5-4-target1-route-lint.log`.
