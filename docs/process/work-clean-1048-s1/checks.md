# Own checks

Date: 19 November 2026. Baseline:
`f316313f0265e5678c49fc1dcf2c03cbcc3d17d2`.
These are the builder's own checks. Independent review is NOT RUN by this builder.

## Behaviour and test-first evidence

- `45b03fb75`: commit the tests with the original exact JSON-text implementation.
  Observed red: **3 failed, 6 passed**. The failing cases are key order at every
  object depth, objects inside nested arrays and reordered `__proto__` keys.
  Each reports `expected false to be true`. Array ordering, undefined omission,
  null/type differences and native JSON behaviour already pass.
- Implement `sameJson`, then observe **9/9 PASS twice**. The complete event suite
  subsequently runs these tests in both package passes.
- `b4dd28a6e`: pin the browser export, computer image module boundary and tool
  change description. Observe the expected missing public helper/module failures.
  The web test first reports `expected 'Schema changed' to be 'Details changed'`.
  Its unchanged stored revision still yields Details changed after migration;
  key order alone no longer adds schema difference details.
- Test the packaged computer entrypoint against the Dockerfile's actual copy list.
  Its focused run passes; the complete computer suite covers it in both passes.

## Gates

All test, typecheck, lint and build processes use `nice -n 10`. Non-web Vitest
uses one or two workers; database tests use the supplied disposable test database.
No full root test suite is run. No secondary stack is claimed by this builder while these gates run.

| Check | Result | Evidence |
| --- | --- | --- |
| Typecheck, all workspaces and package/dev-stack projects | PASS | No errors. |
| Event catalogue | PASS | 174 event types agree. |
| Knip | PASS | No unused files or exports; existing configuration hints remain. |
| Dependency lint | PASS | No new violations; the 15 recorded exceptions remain unchanged. |
| Changed-file ESLint | PASS | 8 GB heap, zero errors and warnings, including exception comments. |
| JSON equality rejection probe | PASS | Four expected no-restricted-syntax errors, shown below. |
| Libraries: events, protocol, authz, event-store, handlers | PASS twice | 97 files and 1,901 tests per run; no skips. |
| Other touched packages: models, projections, computer, ops, server | PARTIAL | 13,275 current non-web cases have two passing observations across split runs; one newly enabled local-tool case remains failing. The count includes the libraries above. |
| Events after the saved-text characterisation | PASS twice | 39 files and 1,265 cases per run, including exact JSON strings inside ordered pairs. |
| Full web tests | PASS twice | 85 files and 1,593 tests per run; no skips. |
| New test callback naming | PASS twice | 10 library cases and eight focused web cases after naming callbacks; assertions unchanged. |
| Web production build | PASS | Existing style-budget and third-party CommonJS warnings remain. |
| Changelog lint | PASS | Branch release fragment; CHANGELOG.md unchanged. |
| Markdownlint | PASS | Complete configured document selection. |
| README structure | PASS | Existing package headings and diagrams retained and updated. |
| Whole-stream read/debt checks | PASS | 310 recorded reads and five rebuild reads; no new reads or raised limits. |
| Public privacy and secret scanning | PASS | Run again before push after retaining journey evidence. |

[Per-file repeated results](test-files.json) record each source test file and its
passed, failed and unrun cases.

The optional conditions below are **NOT RUN** by these unit selections. A separate
CORE journey does not turn these unexecuted test cases into passes.

| Condition | Cases | Missing opt-in or fixture |
| --- | --- | --- |
| Kubernetes lifecycle qualification | 11 | `LIFECYCLE_K3D` not enabled. |
| Hosted MCP Kubernetes qualification | 37 | `MCP_HOSTED_K3D` not enabled. |
| Personal MCP Kubernetes qualification | 13 | `MCP_PERSONAL_K3D` not enabled. |
| Joined bridge Kubernetes qualification | 1 | `BRIDGE_K3D` not enabled. |
| Deployed live-view browser qualification | 2 | `LIVE_VIEW_K3D` not enabled. |
| Desktop screenshot browser qualification | 1 | `SCREENSHOT_BROWSER` not enabled. |
| Native Codex capture image | 1 | `CODEX_CAPTURE_IMAGE` not supplied. |
| Full approval controls in a browser | 1 | `APPROVAL_BROWSER` not enabled. |
| Approved real-provider calls | 1 | `MODELS_REAL_CALL` not enabled. |

There are 68 unexecuted optional cases. Five files contain only unexecuted cases;
they are labelled `not-run`, even though Vitest reports their file status as passed.
Two complete file passes with the same case counts also establish repeat coverage
when generated date parameters change case titles. Failed or partial file runs
do not supply that whole-file proof.

The following probe was temporarily placed under server production source and
checked with scoped ESLint using the production configuration and an 8 GB heap.
The local instruction restricts ESLint to changed files, so full root lint:code
is NOT RUN locally and remains for CI.

```text
apps/server/src/same-json-lint-probe.ts
  1:28  error  Import sameJson instead of comparing JSON.stringify results  no-restricted-syntax
  2:32  error  Import sameJson instead of comparing JSON.stringify results  no-restricted-syntax
  3:27  error  Import sameJson instead of comparing JSON.stringify results  no-restricted-syntax
  4:31  error  Import sameJson instead of comparing JSON.stringify results  no-restricted-syntax

4 problems (4 errors, 0 warnings); exit 1. Probe removed.
```

## Test environment and failures

The first product batch is **FAIL**, not discarded: 9,452 cases passed,
1,681 failed and 309 did not run. Direct Vitest invocation missed the repository's
pretest step, so gateway fixtures lacked the pinned agentgateway binary.
Mounted computer source also encountered an older fixture image without the new
public module. Run the existing pretest command and build a task-specific computer
fixture image; keep the shared image unchanged. The gateway and computer identity
smoke then passes all 23 cases. No assertion or timeout changes.

Repeat the unsuccessful files with those fixtures, and repeat the originally
successful files separately. The per-file record preserves the failed batch and
both successful observations rather than presenting the initial batch as green.
The 74-file corrected-fixture run is also **FAIL**: 73 files pass, one native-budget
recovery case reports `Model call retry refused`, and two cases do not run.
The 73-file repeat is **FAIL**: 71 files pass and four cases fail across Forget
and Remember backend delivery. Forget misses its second turn dispatch within the
existing 30-second wait. Two Remember cases return an unconfirmed-result response;
another does not reach the final append hook. All passed in the earlier corrected
run. The other repeat reports a long-session socket-ready timing failure; a focused
probe also fails at 1,547 ms against the unchanged 1,500 ms threshold.

Reduce the total fixture-worker limit from three to two for a controlled run:
one worker executes those four complete files while the remaining selection uses
one worker. The [resource snapshot](sequential-resources.json) records a one-minute load of 4.71
at its start. All four files and
182 cases **PASS**. The complete native-budget file then **passes again**, all 46
cases, giving its previously failing recovery case two successful observations.
The long-session measurements are history 190 ms, list 121 ms and socket ready
1,446 ms. No production code, assertion, timeout or access window changes for
these runs. The earlier three-worker failures remain **FAIL** for that condition;
this evidence does not claim qualification under that load.

## Remaining blocking gate

The final 403-file selection is **FAIL**: 9,405 cases pass, two fail and 66 do not
run. Its chat timing failure is covered by the later unchanged controlled run.
Its additional failure is the local real-tool image-check case, which was skipped
before tool preparation. Three companion cases pass, but the clean-scan case times
out waiting for a failed queue job. An isolated full-file run also **FAILs** with
three passed and one failed case. No second full-file pass was attempted after
that failure.

A focused diagnostic with temporary logging **PASSes** and logs `handler.failed`
with `Hosted image check unavailable`, the expected missing-database outage.
That observation does not prove the source of the full-file timeout. The diagnostic
was not counted as qualification, and its logging changes were removed. No repair
or larger timeout is shipped. This remaining failure blocks source readiness and
the required fresh CORE journey.

The budget stop leaves **13,275 current non-web cases with two passing observations,
one unresolved case and 68 NOT RUN optional cases**. All five library packages and
web have passing repeated coverage; the ops gate remains PARTIAL. The earlier
failed batches are retained rather than relabelled green.

## Comparison acceptance

The [audit](comparison-audit.md) lists all 73 AST sites and what each comparison
decides. Nineteen migrate; 54 retain their original expression and exact result.
An AST set comparison confirms that every remaining direct comparison is one of
those documented exceptions. These include conservative retention of replay
verification, which must not newly accept reordered input without owner approval.

The issue's grep reports **49**, so its zero-count criterion is **PARTIAL under
the explicit behaviour-care exception**, rather than claimed to pass. It misses
five multiline or nested retained comparisons. The original grep count is 64;
the original AST count is 73. There is exactly one `function sameJson` declaration
and no Node import in its file. Existing Node isDeepStrictEqual comparisons and
hash/stored-text uses remain outside this change.

## Made right

Share one comparison through the event and browser contracts. Split native JSON
normalisation and object-key sorting into short named functions. Reuse the ID
lint restriction instead of copying it when extending flat configuration.
Name the new test callbacks and rerun their unchanged assertions twice.
Delete 19 direct comparison expressions. Keep sensitive checks explicit and
shorten their exception comments without changing their expressions.

The largest new function has at most 14 counted lines; each has at most two
parameters. No size limit is raised, dependency added or caught error discarded.
Shipped source is **139 added/deleted lines**, plus two runtime packaging lines
and 36 lint/dependency configuration lines: **177 non-test code/config lines**
conservatively. Tests and receipts are excluded.

Clean-code CRAP/mutation tooling is NOT RUN: the optional tools are not installed
and the standard has not enabled those gates. No independent review is claimed.

## Live qualification

[Fresh CORE journey receipt](journey.md). NOT RUN: one source gate remains failing; the remaining task allowance cannot safely cover an unproven repair, fresh CORE and cleanup.
