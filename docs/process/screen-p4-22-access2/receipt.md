# Model access paging and reload recovery

15 October 2026. Source: `work/screen-p4-22-access2`, based on `976c2fb2`.
The first commit, `211ea1b9`, records the failing tests before implementation.
The implementation and captures are in the commit containing this receipt.

The browser checks use the production web build with intercepted API replies.
They do not use a dev stack or a fresh install. The six new captures show Load more,
Applying after reload and Outcome unknown after reload, at 1280 and 390 pixels.
They reuse the status line and footer from the accepted access drawer frames;
those frames do not include paging or reload recovery. No Missing rows are invented.

- PASS: failing-first run, with 21 expected failures before implementation.
- PASS: the editor and registry Vitest specs, 86 tests, twice under `nice -n 10`.
- PASS: `nice -n 10 npm run visual:screen-p4-22-access -- --part2`. A held POST,
  page reload and reopened drawer produce no second POST. Status reads retain the
  original id. Saved clears storage; Applying and unknown results offer Check status.
  A 404, 503, network failure or mismatched receipt cannot show Saved.
- PASS: existing save, double-click, conflict, retry, refusal and focus-return checks.
  The new captures have no horizontal overflow and use targets of at least 44 pixels,
  with reduced motion enabled. All six captures were inspected.
- PASS: web build, workspace typecheck and event catalogue check.
- PASS: lint, including Knip, documentation, links and changelog checks.
- NOT RUN: local full root suite and security-rules; no protocol or API fields changed.
- NOT RUN: fresh-install journey, real providers and real permission services.
