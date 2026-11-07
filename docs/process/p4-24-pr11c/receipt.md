# Own checks for the company routine audit

7 November 2026. Source: `739613b25`. The worktree used disposable NATS,
PostgreSQL and OpenFGA on the shared host. It was not a fresh installation.

- PASS: the company audit expected one saved claim for the exact owner, occurrence,
  chosen profile, verified account and free published tool. The first claim saved
  one record; a duplicate, changed evidence, lost grant and uncertain reply refused.
- PASS: two final runs of the focused tests passed 110/110 each.
- PASS: all 460 unchanged security-rule tests, changed-file ESLint, dependency
  check, workspace typecheck, event catalogue, Knip, changelog and README checks.
  Typecheck output is in `/tmp/p4-24-pr11c-typecheck.log`.
- PARTIAL: this first part audits a synthetic verified account. Company custody
  hand-off, recording upstream, production caller and live account activation
  have no result here.
- NOT RUN: local root suite, owner stack and fresh-install routine journey.
