# Own checks and work log

This is slice 1 of 2. The builder ran no independent review. The orchestrator owns
those passes. No product behaviour, event type, field, dependency, timeout or
access rule changes.

## Test first

Commit `6e89a22df` contains the initial boundary test alone. It failed at
`recordIdPattern.test(value)` because the shared export did not exist:
`TypeError: Cannot read properties of undefined (reading 'test')`.
The test compares the shared checks with both old literals and fixed expected
results for lengths 0, 1, 200 and 201, valid ASCII characters, punctuation,
whitespace and non-ASCII text.

The smallest shared helper made that test pass. Later tests check the provider
alias, the browser re-exports and distinct model grant IDs. The grant behaviour
[passed before extraction](grants-before-split.log).
All five final tests passed [once](changed-tests-1.log) and
[again](changed-tests-2.log).

## Make it right

- Shared one record ID pattern and schema in `libs/events`; exposed them through
  `libs/protocol` for browser callers. Kept `providerIdSchema` as an alias.
- Replaced all 168 production literals and the two web-spec literals under `src/`. Deleted four redundant local pattern
  aliases, two stale schema imports, one unused local schema and one unused Zod import.
- Moved the existing assistant grant schema into `assistant-grant.ts` after pinning
  its model/record distinction. Adding an import had taken `data.ts` above its
  500-line limit; extraction leaves 497 counted lines. No limit was raised and no
  statement was compressed to fit.
- Added an `events/ids` entry point and copied `ids.ts` into the computer image.
  The image deliberately includes selected event modules. A new isolated runtime
  test reads the actual Dockerfile copy list and calls the packaged upload ID
  validator. It [failed first](runtime-red.log) on the missing full event index
  in commit `f2c18a37c`, then passed twice with the narrow import.
- Removed the redundant local audit schema alias. The audit projection remains at its
  original 544 counted lines rather than growing an existing oversized file.
- Added no product function or error handler. Changed functions retain their
  existing parameters and decisions; no caught error loses its cause.
- Kept composite IDs, route patterns, model IDs, OAuth scopes and chat route IDs
  distinct. See the [copy audit and retained-pattern reasons](id-audit.md).
- Updated the event and browser-contract guides and diagrams. No event catalogue
  row changes because the event types and payloads are unchanged.

Application/library source: 332 added plus 184 deleted lines, **516 total**.
Including the image recipe, package entry point and both root check configurations,
the conservative shipped-code count is **533 added plus deleted lines**. Tests,
guides, release notes and receipts are excluded.

## Work log

1. Checked `origin/main`, the card and open PRs. No existing slice PR or merged
   helper was found. The branch starts at `cdb8b80bf`.
2. Installed the locked dependencies and linked the existing NATS and link-checker
   tools. Added no dependency.
3. Counted both spellings, wrote and committed the failing public-contract test,
   then added the helper and migrated one package per commit.
4. Removed stale declarations and local pattern aliases; split the grant schema
   to preserve the file-size limit without widening the slice.
5. Probed both old literals in a temporary production file. ESLint rejected both
   with `no-restricted-syntax`; the [output](lint-probe.log) is retained.
6. Reproduced and fixed the computer runtime import using the existing Zod runtime
   dependency. Added no package dependency or whole event library to the image.
7. Ran own gates and package suites. An initial package run lacked the pinned
   gateway fixture binary and was interrupted. Fetched the repository's existing
   fixture binary before the valid run. One dependency check overlapped deletion
   of the temporary lint probe and failed on its missing file; the subsequent
   check ran after removal and passed.
8. Found that the existing local Docker fixture image predated the new ID module.
   A [direct import probe](stale-image-probe.log) reproduced
   `ERR_PACKAGE_PATH_NOT_EXPORTED`; mounted current source could not start.
   Stopped the invalid package/computer runs, rebuilt the normal CI fixture using
   its checked-in Docker recipe, and repeated the same probe successfully.
   [Build output](fixture-build.log) and [successful probe](current-image-probe.log)
   are retained. No release image was promoted, source assertion changed or timeout
   lengthened. The final complete package run uses stable source and this fixture.
   The interrupted runs reported two collection failures while exports changed,
   plus container startup failures against the old image. They are not PASS results.

9. Completed all eight non-web package suites. The [initial complete batch](package-tests-initial.log)
   passed 12,877 cases and failed two first-success setup assertions before their
   intended security checks. It skipped 72 opt-in cases; the [skip list](package-skips.log)
   is NOT RUN qualification.
10. Reused the existing `memoryClock` helper for the Forget replay test and
    `startRunning` for the routine prohibition cases. These remove dependence on
    host elapsed time during successful setup. The replay refusal and the routine's
    real-clock two-second interruption limit remain unchanged. The eight affected
    cases [passed together](fixture-fixes.log). All six ID/runtime, repaired server and audit test files then
    [passed together](post-fix-tests-1.log) and
    [passed again](post-fix-tests-2.log): 361 cases per run, no skips.
    Removed a redundant catalogue alias; neither test file's size limit was raised.

11. Extended the copy audit to include specs under `src/`. The stricter lint rule
    rejected two web-spec copies before their migration. Both now use the shared
    pattern, and only `ids.ts` is exempt under `src/`. The all-source count is
    170 before and one after; no copy remains outside `ids.ts`. Repeated all web
    tests twice and checked the updated spec types and lint.

12. Ran the fresh CORE journey after source checks. Copied 37 screenshots and
    sanitised logs before teardown. Both secondary slots reported free afterwards.
    Approval and optional provider qualification remain NOT RUN.

## Complete package batch

| Package | Cases passed in the complete batch | Failed | Opt-in cases NOT RUN |
| --- | ---: | ---: | ---: |
| `libs/events` | 1,249 | 0 | 0 |
| `libs/auth` | 196 | 0 | 0 |
| `libs/protocol` | 66 | 0 | 0 |
| `libs/projections` | 217 | 0 | 0 |
| `libs/models` | 2,819 | 0 | 2 |
| `apps/computer` | 1,028 | 0 | 0 |
| `apps/ops` | 446 | 0 | 65 |
| `apps/server` | 6,856 | 2 | 5 |

The batch ran with two workers and the prescribed shared disposable PostgreSQL
fixture. Web qualification is separate below. The two failed setup tests are
retained in the batch evidence; later results do not relabel that run as PASS.

## Live qualification

All default source-suite cases have passed across the complete batch and the
repaired-file reruns above. The original batch remains a FAIL result. The live
CORE journey is [PASS](journey.md) on a fresh secondary stack at head
`44f739f458e67fe8c6f1cf4c1411373b2a4e7314`; startup, status and teardown all exited 0. Standalone computer image qualification and optional
native-provider qualification are separate from the source test suites and CORE.

## Gate results

All commands use `nice -n 10`. The ESLint process has an 8 GB heap and checks
changed code files only, following the local lint-scope instruction.

| Gate | Result | Output |
| --- | --- | --- |
| Typecheck, all workspaces, package and dev-stack | PASS | [Log](typecheck.log) |
| Event catalogue, 174 types | PASS | [Log](events.log) |
| Scoped ESLint, zero warnings | PASS | [Log](eslint-final.log) |
| Dependency rules | PASS | [Log](deps.log) |
| Knip | PASS, two existing configuration hints | [Log](knip.log) |
| Changelog | PASS | [Log](changelog.log) |
| Markdownlint | PASS | [Log](markdown.log) |
| README structure | PASS | [Log](readmes.log) |
| Lint debt | PASS | [Log](debt.log) |
| ID/runtime tests, five cases, twice | PASS | [First](changed-tests-1.log), [second](changed-tests-2.log) |
| Final six ID/runtime, server and audit files, 361 cases, twice | PASS | [First](post-fix-tests-1.log), [second](post-fix-tests-2.log) |
| Web tests twice, 85 files and 1,592 cases per run | PASS | [First](web-tests.log), [second](web-tests-2.log) |
| Updated web-spec types and ESLint | PASS | [Types](web-typecheck.log), [lint](web-eslint.log) |
| Whole-stream read baseline | PASS | [Log](reads.log) |
| Web production build | PASS, existing dependency warnings | [Log](web-build.log) |

The full root suite and full root ESLint command were NOT RUN under the supplied
local scope. All nine touched packages' existing source suites ran; the complete non-web
batch and the two repaired-file runs are reported separately above.
