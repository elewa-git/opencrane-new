# Local memory collection fixtures

5 November 2026. Part of #97. Source: test commit `67b0e742f` and this PR's
implementation. Environment: local controlled observations and disposable Node
containers; no claimed slot, deployment image or fresh-install qualification.

- PASS: the tests were committed before the launcher. A container-silo regression
  reproduced two evidence writes before refusal;
  the launcher now refuses that mismatch before writing anything.
- PASS: 29 launcher fixtures twice; 460 unchanged event-security tests once.
  Synthetic PASS exercises the real collector and reader; it is not a live receipt.
- PASS: six existing real-container supervisor cleanup tests. All suites use
  `nice -n 10`. CI first failed because the new fixtures were not selected. The
  Node test entry now runs them in CI. Final CI status is in the pull request.
- NOT RUN: full root suite, live collection, bootstrap, native qualification and
  model calls. The single 5i4 journey must collect on its own new installation.
