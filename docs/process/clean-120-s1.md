# Lint size debt checks

Date: 13 November 2026. Branch: `work/clean-120-s1`. Base:
`90a99afa75e508f32c505d82a4beacc45e236dfd`. This is slice 1 of #120.
The product-source changes are size comments only. No suppressed function was
changed and no file was split.

## Fresh secondary stack

Journey on a fresh dev stack: FAIL (core journey; no product change).

One fresh attempt used secondary id 2, claimed through `claim.sh`. The Zitadel
credential was supplied by file path, without reading or printing it. Bootstrap,
provider setup and website readiness passed. Website readiness took 89,257 ms.
The core journey entry then refused the inherited fleet-task marker:
`Automated journeys require a secondary stack and no fleet task`.

This is a main defect in the core-entry guard, outside the lint change. No core
browser step ran. The guard was not changed or bypassed and the journey was not
retried. Main's core journey repair is [PR #1119](https://github.com/elewa-git/opencrane-new/pull/1119).
The EXIT trap ran `down.sh`; the secondary claim and its stack directory were
removed. The owner stack was not used.

The attempt ran from `7233f8a54` with the in-progress lint-only working tree.
Product executable code matched the base commit; subsequent product-source
changes also only number existing size exceptions.

## Checks and manual proof

- PASS: clean `npm ci`; pinned NATS and Lychee tools linked into `.tools`.
- PASS: 21 debt-check tests and 52 CI script tests, including four baseline-helper tests.
- PASS: repository typecheck, event catalogue (174 types), changed-code ESLint,
  Markdown lint without file arguments, Knip and changelog lint.
- PARTIAL: the initial full default-heap lint measurement was stopped after
  running close to the default heap limit. Subsequent full scans use CI's existing
  `NODE_OPTIONS=--max-old-space-size=8192` setting.
- NOT RUN: full root tests, as instructed. Existing product tests were unchanged
  apart from numbered size comments. Separate web tests/build were not run as
  source gates; the fresh startup built the website before the entry refusal.

All lint, typecheck and test commands ran under `nice -n 10`.

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
