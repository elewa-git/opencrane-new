# Own check receipt

Part of #106. These are local checks on the saved success-finish path.

- PASS: the failing-first test commit showed an approved call refused before the source
  change. After the first fixes, the settlement correction test caught a false success.
- PASS: the three changed suites passed twice on the final source, 120 tests each time.
  They use the company release audit, a real budget actor hold, and a final write race.
- PASS: the company broker test now lives under the server app. It keeps its assertions
  and no library test imports server code. The three affected suites passed twice again,
  with 120 tests on each run.
- PASS: workspace typecheck, final server and models typecheck, scoped ESLint, Markdown
  lint, Knip, event catalogue and changelog checks.
- PARTIAL: the internal finish path is checked with disposable services. A live
  company sender and owner-only result links are outside this bounded part.
- NOT RUN: local root suite, fresh-install journey or paid model call.

Tests used the supplied PostgreSQL test URL and disposable NATS. Full lint runs in
GitHub CI because the shared-box instructions limit local lint to changed code.
