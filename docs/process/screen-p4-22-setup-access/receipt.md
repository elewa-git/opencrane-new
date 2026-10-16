# Provider setup access

Date: 16 October 2026. Source: `24dfbc49e88af8c289045b379a8b5d46c07ebfa4`.
The branch was rebased once onto `6c59db541f1129216b3e110a2ab70401de2f8d1c`.
The browser checks use intercepted replies at 1280 and 390 pixels, with reduced
motion. This is a local browser fixture, not a fresh installation. No dev stack,
real names or provider credentials were used.

## Before and after

The tests were committed first in `91ea4e27`. Running the setup tests against
that commit produced 6 failures and 13 passes. An earlier attempt could not build
because a type package added on main was missing locally; `npm ci --ignore-scripts`
restored the locked dependencies before the recorded failing run.

| Condition | Before: observed failure | After: expected and observed result |
| --- | --- | --- |
| Failed bindings read | A saved model became unchecked. | PASS: the saved checkbox stays checked and disabled; model posts retain it. |
| Unsupported bindings read | A saved model became unchecked. | PASS: the same removal block applies, with an explanation about checking existing uses. |
| Lost grant reply, Back, attempted untick/re-tick, Access | Check status disappeared. | PASS: the pending model stays selected, including when absent from the latest saved list. Status reads the first command id; Save cannot post another command. |
| Lost grant reply, Close | The setup dialog disappeared. | PASS: Close, Go to Models and Escape keep it open. Status uses the first command. After it resolves, close and reopen work. |
| Selection receipt followed by a smaller server list | Done ticked the draft count of 3. | PASS: Done ticks the returned count of 1 when its revision matches the receipt. |
| A later provider revision | Done retained the tick from an older receipt. | PASS: no enabled-model tick appears for a different revision. |

The existing selection test now supplies the receipt revision returned by the real
API. The pending-command tests assert that Save is absent and also invoke its
handler to verify that no second POST is sent.

A further failing-first test in `f54f530d` found that a model added by another
admin could appear unticked after a fresh provider read. That run had 1 failure
and 19 passes. PASS after `24dfbc49`: the checkbox reads the saved list too, stays
checked and disabled, and Next sends no replacement selection.

## Local checks

PASS: 126 tests across the four Models test files, twice, using:

```sh
PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres nice -n 10 npm test -w apps/web -- --watch=false --include='src/app/models/*.spec.ts'
```

PASS: workspace typechecks, the web build, `check:events` (142 matching types)
and `lint:changelog`.
No full root test suite was run. These browser component tests do not use PostgreSQL.

## Browser captures

Command: `nice -n 10 npm run visual:screen-p4-22-setup-access` after
`nice -n 10 npm run build -w apps/web`.

- PASS: Access, partial saves, Done and skipped-test captures at both widths.
- PASS: saved-model captures at both widths show disabled selections and the
  explanation about checking existing uses before removal.
- PASS: no horizontal page overflow; visible buttons have 44-pixel targets.
- PASS: one model saves while another keeps an unknown result and its reference.
- PASS: Done shows the server count of 1 while the draft contains 2 models.
- PASS: both footer close controls are disabled while the grant remains unknown.
- PARTIAL: the existing setup shell stays in use. Each selected model has its own
  editor and save controls. Done lists separate receipts without an overall success claim.
- NOT RUN: fresh-install qualification and real provider calls. Reviewed model
  removal and configured-use Missing rows remain outside this change.

The command writes ten PNG files in this folder, including
[saved models at 390px](saved-models-390.png) and
[Done at 1280px](MOD-21-1280.png). The browser asserts layout and state; the unit
tests above check command ids and navigation recovery.
