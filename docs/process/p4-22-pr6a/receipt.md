# Own checks for the provider retirement preview

7 November 2026. The tests use
disposable NATS, PostgreSQL and OpenFGA fixtures on the shared host.

- PASS: regression test commit `c413f78e8` first exposed a replacement without
  a payer and a proposal accepted after a routine appeared during preparation.
- PASS: the two changed provider suites passed 63/63 twice after the fixes.
  An earlier run failed because the new routine also appeared in a later fixture;
  that test now checks the exact two saved routine rows.
- PASS: changed-code ESLint, repository Markdown lint, event catalogue, Knip and
  changelog validation. The release fragment is outside the Markdown lint file list.
- PASS: full workspace, package and development-stack typecheck. The changed
  models and server packages also passed their own typechecks after the last edits.
- NOT RUN: local root suite, development stack and fresh-install retirement journey.
- PARTIAL: old and current routines still have no model binding. This preview
  blocks their review; no retirement command, dispatch exclusion or settlement
  change is present.
