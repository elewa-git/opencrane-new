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
suppression entry is checked against those manual observations.

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

## Remaining evidence

The debt totals, full lint and acceptance probe results are recorded below when
those commands finish. A skipped condition is not a passing condition.
