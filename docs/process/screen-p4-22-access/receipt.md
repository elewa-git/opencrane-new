# Model access editor screen checks

The capture script serves the web build with intercepted API replies. No dev stack
or paid model call is used. The screenshots cover the editor and loading, no audience,
conflict, access lost, nothing changed, unknown and saved states at 1280 and 390 pixels.

The drawer uses the shared keyboard controls and fills the phone screen. Captures use
reduced motion and check horizontal overflow and 44 px controls. The fixtures check
one-row saves, duplicate clicks, status reads, fresh lists and focus return.

Configured uses are not in the API. The editor never invents Missing rows or a person's
name or time for a conflicting edit. It shows actual grant counts, without claiming
that a connection works. Provider and binding facts remain separate.

Reload recovery and candidate Load more are deferred. Pending commands survive closing
the drawer in memory; reloading discards them. The picker shows at most 50 candidates
per kind and says when more exist. Grant paging is outside this change.

PASS: npm ci, lint (including knip and changelog), typecheck, event catalogue and web build.
PASS twice: 56 provider tests, 60 existing model-screen tests and the browser checks above.
PASS once: 419 security-rules tests. Tests and builds ran under nice -n 10. The provider
tests used a disposable PostgreSQL container, which was removed with its volume.
Fresh-install journey: NOT RUN. The root suite was not run locally.
