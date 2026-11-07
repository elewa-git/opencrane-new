# Own checks for the provider retirement preview

7 November 2026. The tests use
disposable NATS, PostgreSQL and OpenFGA fixtures on the shared host.

- PASS: test-first commit `230dc89ff` received 404 from the missing route.
- PASS: the two changed provider suites passed 61/61 twice.
- PASS: the unchanged event security rules passed 460/460 once.
- PASS: changed-file ESLint, changed Markdown checks, event catalogue, Knip and
  changelog validation. Markdown for the release fragment used the normal rules
  except the heading rule, which does not fit a gathered changelog line.
- PASS: full workspace, package and development-stack typecheck.
- NOT RUN: local root suite, owner stack and fresh-install retirement journey.
- PARTIAL: old and current routines still have no model binding. This preview
  blocks their review; no retirement command, dispatch exclusion or settlement
  change is present.
