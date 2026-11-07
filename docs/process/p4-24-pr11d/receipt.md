# Own checks

7 November 2026. These checks used disposable NATS, PostgreSQL and OpenFGA test
fixtures and a synthetic company account. All tests, ESLint and typecheck ran
under `nice -n 10`.

- PASS: the new test failed first because an unchanged catalogue check advanced
  the server stream position. The test commit preceded the fix.
- PASS: the changed broker tests passed twice on the fixed source, 49/49 each
  time. They include a real Ask-mode success, an unchanged catalogue refresh,
  a rejected decision with a saved use, and a Block refusal at the same policy
  revision as the Ask.
- PASS: scoped ESLint, repository Markdown lint, workspace typecheck,
  `check:events` (162 matching event types), knip and `lint:changelog`.
- PARTIAL: the upstream is a recording test callback. The company sender and
  fresh-install live journey are not in this part. Routine execution remains
  disabled.
- NOT RUN: the full root test suite, full root lint or an owner development
  stack.
