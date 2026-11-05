# Local memory collection fixtures

5 November 2026. Part of #97. Source: failing test commits `d77a76d95` and
`072bd0543`, followed by the implementation in this PR. The branch was rebased
onto `cd74ed12d`, the fetched `origin/main`, with no rebase left in progress.
Environment: local controlled observations and disposable Node containers;
no claimed slot, deployment image or fresh-install qualification.

- Expected FAIL before the fix: enabled swap and core dumps produced only the
  generic launcher error. Both regressions failed while the other 29 fixtures passed.
  The collector also discarded the host reason. Real container tests showed that
  the supervisor discarded the runner's refusal when it exited with status 1.
  These tests were committed before the implementation changed.
- PASS: all changed tests passed twice: 31 launcher fixtures, 61 collector tests,
  11 supervisor tests and one image-owned entry test. The Node test entry also passed
  twice. Synthetic PASS exercises the real collector and reader; it is not a live receipt.
- PASS: 46 related host-probe and result-reader tests twice. The supervisor tests
  include timeout, cancellation, output limits and cleanup of child processes.
  Failed processes cannot return PASS or attach private data to a host refusal.
- Initial targeted batch FAIL: one existing test still expected the generic reason
  from the real runner. It now requires the exact host refusal and fixed message,
  while keeping the checks that earlier PASS is withdrawn and collection stops.
  The complete 119-test batch then passed. The corrected 61-test collector suite
  passed again separately.
- PASS: repository typecheck, collector typecheck, check:events and lint:changelog.
- PASS: lint, including knip, with CI's `NODE_OPTIONS=--max-old-space-size=8192`.
  ESLint reported zero errors and 36 warnings. The initial lint attempt was stopped
  near Node's default heap limit; the rerun completed all lint steps.
- NOT RUN: full root suite, live collection, bootstrap, native qualification and
  model calls. The single 5i4 journey must collect on its own new installation.
  Admission remains off. No host setting or owner stack was changed.

All checks and test suites ran under `nice -n 10`. Tests used
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`; these selected
suites do not use PostgreSQL or projections. Commands, from the repository root:

```sh
nice -n 10 npx vitest run --config infra/dev-stack/memory-qualification.config.mjs
nice -n 10 node --experimental-strip-types --test infra/dev-stack/memory-qualification.test.ts
nice -n 10 npx vitest run --config scripts/private-memory-qualification/vitest.config.mjs \
  scripts/private-memory-qualification/deployment.test.ts \
  scripts/private-memory-qualification/container-process.test.ts \
  scripts/private-memory-qualification/journey-container.test.ts \
  scripts/private-memory-qualification/host-probe.test.ts \
  scripts/private-memory-qualification/result.test.ts
```
