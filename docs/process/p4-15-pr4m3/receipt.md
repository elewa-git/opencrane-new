# Saved recall preparation

5 November 2026. Part of #97. First split of PR 4m3.
Rebased onto `f8d3e36b16324655c297c434fc1a58c2b8ae77c5`; the rebase finished
and the base is an ancestor of this branch. Implementation: `3bcfe4dc3`.

## Scope

The server prepares recall definitions from saved admission, personal assistant ownership,
current policy and deployment-owned qualification. Pending and loaded receipts must match
the trusted local registration. Each preparation accepts one completion attempt, including
when that attempt fails. Its bridge request contains definitions and identity fields only.
It cannot release private input or issue credentials. Admission remains disabled.

Preparation and completion refuse saved invalidated or ended memory, even while the Stop
reaction is pending and the caller remains registered. The existing loaded-memory validator
checks saved references, scope changes and read permissions without decrypting facts.
A competing load during confirmation refuses so it cannot introduce unchecked references.
Conversation and scope history load before the two-second check over small access streams.
Later activity and scope checks read only new events. Unrelated activity remains allowed.

Both return paths check the local caller after all waits. Named functions separate request
preparation, receipt completion, saved turn checks and assistant ownership. Refusal branches
use braces. No dependency, event type or production bridge caller was added.

## Failing-first evidence

Each behaviour change follows a committed regression:

- `c7a9b3bd4`: five cases wrongly returned approval after saved invalidation or ending.
  Two cases with invalidation during completion already refused. All seven passed after
  the saved-state check. Correct and Forget use real saved events with Stop left pending.
- `928d63956`: two cases wrongly returned `recall_load` when the caller closed during
  final access or activity confirmation. Both passed after the final caller check.
- `633d920b2`: four cases wrongly accepted corrected or forgotten loaded references before
  invalidation was saved. The unchanged-reference success case passed throughout.
- `11e1f3d12`: a competing recall added references after the completion snapshot and
  wrongly received approval with the new-load refusal disabled.

## Own checks

Environment: this worktree, disposable NATS/OpenFGA fixtures and simulated deployment
measurements. Commands use `nice -n 10`. Vitest uses one worker, no file parallelism and
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`.
These selected tests do not need PostgreSQL; their service fixtures start and stop normally.

- PASS: 111 preparation tests twice on the final implementation, plus 42 unchanged
  catalogue/activity tests and 58 deployment-reader tests: 211 distinct tests.
- PASS: full typecheck, final server typecheck and qualification-script typecheck.
- PASS: focused ESLint on the changed server module and test file.
- PASS: `check:events`, with 158 matching event types.
- PASS: repository lint, including Knip, dependency checks, documentation, links,
  fixtures, licences and `lint:changelog`. ESLint reported zero errors and 35 existing
  size warnings; the changed module and tests have none.
- NOT RUN: full root suite, development stacks, paid model calls and fresh-install journeys.

Logs use `/tmp/p4-15-pr4m3-fix-` followed by `red1.log` through `red4.log`,
`final3.log`, `final4.log`, `deployment.log`, `lint.log`, `typecheck.log` or `events.log`.

## Remaining work

PARTIAL: authenticated bridge delivery, abandoned-load cancellation, initial-input and
credential gates, real backend recall and saved loaded evidence before bytes remain for
the next split. The native numeric input generation and saved memory input generation are
separate existing identities. A local catalogue approval does not replace saved memory
or wire authentication. Native writes, shared scope and live qualification remain separate.
