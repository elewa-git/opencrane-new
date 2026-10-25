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
