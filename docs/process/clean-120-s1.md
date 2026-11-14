# Lint size debt checks

Date: 14 November 2026. Branch: `work/clean-120-s1`. Rebased onto
`origin/main` at `1e8588842`. Rebased head: `024dd6710ecb5452d1f2ca1cc93dcafd1a7e2457`.
This is slice 1 of #120. The product-source changes are size comments only. No
suppressed function was changed and no file was split.

## Fresh secondary stack

Journey on a fresh dev stack: PASS — 14 November 2026, head
`024dd6710ecb5452d1f2ca1cc93dcafd1a7e2457`, secondary stack 1.

`infra/dev-stack/up.sh --fresh` completed its built-in core journey. The separate
`infra/dev-stack/journey.sh` run also passed. Both used the real Zitadel login in
the OpenCrane 2 Dev organisation. Bootstrap, provider setup, website readiness,
access refusals, uploads, chat, live view at 390px and 1280px, lifecycle, replay,
audit and budget-ceiling checks passed. The approval journey was skipped because
it waits for rows 4, 5 and 14 of #45; that condition is outside this slice. The
secondary stack was stopped with `down.sh` after the journey.

Screenshots from this fresh run:

- [Chat at 390px](screenshots/chat-390.png)
- [Chat at 1280px](screenshots/chat-1280.png)
- [Live view at 390px](screenshots/live-view-390.png)
- [Action history at 390px](screenshots/action-history-390.png)

## Rebased-head checks

- PASS: changed tests, 15 files; 2,498 passed, 1 skipped (2,499 total), under
  `nice -n 10` with `PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`.
- PASS: fresh-stack startup and the separate core journey described above.
- PASS: changed-code ESLint and `npm run lint:debt`.
- PASS: `npm run typecheck`, `npm run check:events` (174 types), Knip and
  `npm run lint:changelog`.
- PASS: `npx markdownlint-cli2` with no file arguments (CLI reported 0 issues in
  0 files).
- PASS: public-privacy check, commit-range secret scan and force-with-lease push
  of evidence head `b169bffebc805a286449399a8bfeabbff41830d4`.
- PARTIAL: CI was pending on that evidence head. The watch was stopped so this
  receipt could include the scan results; the final pushed head will be watched.

After the rebase, main added lines to two capped test files. Their existing
maximums and matching ESLint comments were raised to the exact counted line totals
(2,999 and 6,104). This is lint bookkeeping only; test and product behaviour did
not change.

The following source-slice checks were run before the rebase and retain their
original evidence below; they do not replace the post-rebase checks above.

Before generating debt, a focused ESLint command measured `decision.ts` at 565
counted lines and `connection-custody.test.ts` at 6,083. Their caps were added by
hand. That same command reported two long functions and four parameter violations
in `decision.ts`, including `startDecision` at 325 counted lines. The generated
suppression entry matches those manual observations exactly.

The checker tests were written first. The first command test failed because the
checker did not yet exist; the baseline tests likewise failed before their module
existed. Later regression tests reproduced accepted multiline disables, duplicate
cap properties and inline parameter overrides before the fixes. The checker now
uses actual parsed comments, the documented cap format and one matching comment
per listed file/rule.

## Unused suppression proof

PASS, using the installed ESLint 10.11.0 in a disposable fixture. A six-parameter
function with one hand-written `max-params` suppression passed. After shortening
the function, `npx eslint . --max-warnings 0` exited 2 and requested pruning.
`npx eslint . --prune-suppressions` then exited 0 and left an empty suppression
record. The fixture was removed. This proves the CLI behaviour separately from
the seven repository-wide rejection probes.

## Recorded debt

Bulk generation used exactly `--suppress-rule max-lines-per-function` and
`--suppress-rule max-params`. It exited 0. The committed suppression record contains
only those rules: **39 function-length violations** and **298 parameter violations**.
The two totals are appended to `benchmarks.jsonl`.

The exact exception list contains **eight production file caps, sixteen test file
caps and one complexity disable**. There are no `eslint-disable max-lines` comments
under apps or libs. `npm run lint:debt` passes on snapshot
`2195ab19a04e710a593f1292d52222e8ddd4f104`.

## Acceptance probes

All seven cases ran separately through repository-wide `npm run lint`, with
`BASE_SHA=2195ab19a04e710a593f1292d52222e8ddd4f104`. The comparison needs a base
containing the new ledgers, so this snapshot proves later debt cannot rise.
Each run temporarily added ESLint's content-cache flags to `lint:code`; the rule
configuration, file scope and zero-warning requirement stayed the same. The final
full gate uses the committed command without caching.

| Temporary violation | Expected rejection observed | Seconds |
| --- | --- | --- |
| 81 counted-line function | PASS, exit 1: max-lines-per-function | 639.89 |
| Six parameters | PASS, exit 1: max-params | 17.00 |
| New 1,501-line test | PASS, exit 1: max-lines: 1,501 > 1,500 | 5.06 |
| Capped custody test +1 line | PASS, exit 1: max-lines: 6,084 > 6,083 | 29.10 |
| Unlisted file-size override | PASS, exit 1: unlisted size exception | 40.60 |
| Listed cap raised by one | PASS, exit 1: cap rose from 565 to 566 | 32.69 |
| Hand-made suppression for a new long function | PASS, exit 1: function-length suppressions rose from 39 to 40 | 32.91 |

All probes were removed. The original package script, list and suppression record
were restored, and the probe cache was deleted. A byte comparison with origin/main
confirmed three replaced production size comments and sixteen added test/spec
comments, with every existing file body unchanged.

## Final full lint

PASS: uncached `nice -n 10 npm run lint`, with CI's 8 GiB Node heap setting,
completed in **722.16 seconds**. `lint:code` used exactly
`eslint . --max-warnings 0` and reported zero warnings. Debt, dependency direction,
unused code, Markdown, folder guides, offline links, fixture checks, package
licences and changelog checks all passed.

This full gate qualified code commit
`2706975bab516fc805222523375e49ccabcea256`. The final edits only complete evidence
and clarify the short style summary. The change has 401 added plus deleted code
and configuration lines, excluding generated suppressions, tests and documents.

The final helper cleanup gives Git output a name before trimming it. All 21
checker tests, four baseline tests and changed-code ESLint passed afterwards.
The earlier complete CI-script run passed 52 tests. No full root suite was run.
