# Provider setup access

The browser checks use intercepted replies at 1280 and 390 pixels, with reduced
motion. They do not start a dev stack or use real names or provider credentials.

- PASS: Access, partial saves, Done and skipped-test captures at both widths.
- PASS: no horizontal page overflow; visible buttons have 44-pixel targets.
- PASS: one model can save while another keeps an unknown result and its reference.
- PASS: 99 targeted tests twice, the existing drawer browser checks, typecheck,
  the web build and the event catalogue check.
- PARTIAL: the existing setup shell stays in use. Each selected model has its own
  editor and save controls. Done lists separate receipts rather than one success claim.
- NOT RUN: fresh-install qualification and real provider calls.
- Deferred to the next part: the Models step's in-use removal guard and its
  MOD-19-in-use captures. Reviewed removal and configured-use Missing rows are absent.

`npm run visual:screen-p4-22-setup-access` writes the eight PNG files in this folder.
