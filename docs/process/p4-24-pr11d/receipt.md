# Own checks

7 November 2026. This worktree uses disposable NATS, PostgreSQL and OpenFGA
fixtures with a synthetic company account. It is not a fresh installation.
All test, lint and typecheck commands ran under `nice -n 10`.

- PASS: the failing-first test commit preceded the implementation. Its first
  run failed because the strict event shape did not yet accept the new binding.
- PASS: focused company broker tests cover one matching release, an absent or
  changed Ask, missing consequence fields, expiry, Block, current access loss,
  concurrent claims and a lost release audit reply. Both final runs passed
  47/47 tests on the final source.
- PASS: the unchanged security rules passed 460/460.
- PASS: `check:events` found 159 matching event types. Knip through
  `lint:unused`, the dependency graph, Markdown and `lint:changelog` passed.
- PASS: full workspace typecheck passed on the final source.
- PASS: full `npm run lint` passed with zero errors and 37 existing warnings.
  Focused ESLint on every changed TypeScript file also passed.
- PARTIAL: the upstream is a recording test callback. The company sender,
  decision status receipt and fresh-install live journey are not in this part.
  Routine execution remains disabled.
- NOT RUN: the full root test suite or an owner development stack.
