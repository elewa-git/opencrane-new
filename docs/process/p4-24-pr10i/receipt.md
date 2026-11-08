# Own check receipt

Part of #106. This records the bounded scheduler gate, not automatic execution.

- PASS: the first test commit failed before the new entry existed. The final
  routine dispatch suite passed twice, 30 tests on each run, with test
  PostgreSQL, NATS and OpenFGA. Four cases started the real routines worker
  with the setting absent, false, true and invalid.
- PASS: temporary removal of the worker startup block made the true and invalid
  cases fail. Removing the disabled helper check made the absent and false cases
  fail. Removing the missing-delivery refusal made its exact-error test fail.
  All three source edits were restored.
- PASS: the read-only routine scan passed 19/19. The unchanged event security
  rules passed 460/460.
- PARTIAL: the unchanged server hand-off file passed 37/38. Its lease-loss
  acknowledgement case timed out in the full run, then passed 1/1 in isolation.
  The first failure remains visible; no assertion or deadline was changed.
- PASS: workspace typecheck, scoped ESLint, Markdown lint, Knip, event catalogue
  and changelog checks.
- NOT RUN: a production sender, generic company call, paid model, fresh-install
  automatic/Ask/Stop/restart journey or the root suite. Public execution remains
  unavailable.

All test, lint and typecheck commands used `nice -n 10`. The PostgreSQL test
fixture was supplied through `PG_TEST_URL`. This part adds no event, public API,
new dependency or second switch.
