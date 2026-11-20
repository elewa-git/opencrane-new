# Install hardening source checks

## Personal assignment updates

Round 2, 20 November 2026. Test-first commit `c9a572b19` reproduces the missing
subscription before a conversation exists. The browser stayed `idle`; the server
returned an unsupported-message error instead of a context update. Both final
regression files were run against the original entry points before the fix:
[browser red](assignment-browser-red.txt), [server red](assignment-server-red.txt).

Fix `f4ce844c1` adds the signed-in member's `chat-context` subscription and shares
the existing HTTP context builder and chat-session validation. It checks active
membership before and after reads and requires `acts_for` for the assistant id.
The browser applies the assignment without another HTTP context read or a reload.
It stops listening when assigned, when another conversation is selected or on page exit.
No event, dependency, access rule, money rule or memory check was relaxed.

Removing both active-member checks made the non-member refusal test fail by
receiving a context message instead of close code 1008
([mutation evidence](assignment-membership-mutation.txt)). The original checks were
restored before the passing runs. The fresh old-image diagnostic also confirms
that a manual reload reveals the projected assignment; see the [journey receipt](journey.md).

The final local gates below passed on the product fix. All tests, lint and
TypeScript checks ran under `nice -n 10`. Server Vitest runs used at most two
workers and the shared disposable PostgreSQL URL. Browser builds used one worker.
No full root test suite ran locally.

| Check | Result | Evidence |
| --- | --- | --- |
| Changed browser tests and workspace/private-reply regressions, twice | PASS | 167/167 each; [first](source-gates/web-round-1.log), [second](source-gates/web-round-2.log) |
| Changed server tests and HTTP/realtime guards, twice | PASS | 5/5 each; [19.68 s](source-gates/server-round-2.log), [19.47 s](source-gates/server-round-3.log) |
| Full workspace, package and dev-stack typecheck | PASS | [Complete command](source-gates/typecheck-final.log) exited 0 |
| Event catalogue | PASS | [174 types](source-gates/events-final.log) agree |
| Knip | PASS | [No unused-code findings](source-gates/knip-final.log); two existing configuration hints |
| Scoped ESLint | PASS | [14 changed code files](source-gates/eslint-final.log); no errors or warnings |
| Changelog | PASS | [Branch release note](source-gates/changelog-final.log); changelog unchanged |
| Markdown | PASS | [Complete configured scope](source-gates/markdown-final.log), without file arguments |
| README structure | PASS | [Existing baseline retained](source-gates/readmes-final.log) |
| Whole-stream reads | PASS | [No new reads](source-gates/reads-final.log); 310 known and five rebuild reads |
| Exact-source CI | PASS | [All jobs](https://github.com/elewa-git/opencrane-new/actions/runs/44763305277) succeeded on `ccea595758` |
| Exact-source application and scanner approval consumers | PASS | Both real consumers accepted [application](https://github.com/elewa-git/opencrane-new/actions/runs/44763328752) and [scanner](https://github.com/elewa-git/opencrane-new/actions/runs/44763332412) artifacts |
| First full fresh packaged journey on fixed source | FAIL | Owner chat passed at both widths; admin opened before OpenFGA applied its permission; [receipt](journey.md) |
| Fresh qualification after fixture correction | NOT RUN | Post-claim admission refused another occupied slot; own claim released; [receipt](journey.md#fresh-requalification-admission) |
| Round 3 fresh packaged journey | NOT RUN | Two-hour admission wait ended while another journey process remained active; no five-minute capacity window qualified; [receipt](journey.md#round-3-admission-wait) |

The earlier results below are tied to their stated source and do not stand in
for these new checks.

## Previous source checks

Date: 20 November 2026. Source: `77fc69f35a6b65cc94bf263ddefa121488ad75c1`,
rebased onto `ed3662d85`. The rebase finished and the checkout was clean before
the packaged qualification. See the [journey receipt](journey.md) for live results.

## Bootstrap completion regression

The first published application workflow failed its existing real-image bootstrap
assertion. Development-owner setup completed, but its completion message had been
replaced with the token-mode message. No image approval was produced by that run.

Test-first commit `00799e209` is the rebased form of `786845dea`. It preserves the
development-owner assertions and adds a real-container token-mode check. The
[failing test run](https://github.com/elewa-git/opencrane-new/actions/runs/44725906712)
ran 17 image checks: the development completion assertion failed and the new token
check passed. The token fixture also requires no development-owner writes or
completion file and still requires the final owner-ready update.

Fix `77fc69f35` selects the completion message by bootstrap mode. It keeps the
existing development message and reports claim readiness only in token mode.
No assertion, access check, retry, timeout, money rule or memory check was loosened.
The finding and fix are recorded in the
[PR comment](https://github.com/elewa-git/opencrane-new/pull/1170#issuecomment-7038226732).

## Completed checks on the rebased source

| Check | Result | Evidence |
| --- | --- | --- |
| Changed package suites, twice | PASS | 643/643 each; no skips; 1,002.50 s and 813.99 s |
| Token/bootstrap integration suites, twice | PASS | 58/58 each; 204.52 s and 186.97 s |
| Real image/layer/bootstrap checks, twice | PASS | 17/17 each; 90.76 s and 112.08 s |
| Complete workspace, package and dev-stack typecheck | PASS | Root command exited 0 |
| Event catalogue | PASS | 174 registered types match the catalogue |
| Knip | PASS | Two existing configuration hints; no unused-code finding |
| Changelog | PASS | Branch release note; no changelog edit |
| Markdown | PASS | Complete configured scope, without file arguments |
| Package README structure | PASS | Eight diagram nodes; fixed headings and size checks |
| Scoped ESLint command | PASS | Exit 0; 13 infrastructure files ignored by configuration |
| ESLint rules on infrastructure | NOT RUN | The existing configuration excludes these files |
| Exact-head CI | PASS | All jobs completed successfully |
| Exact-source application and scanner approval consumers | PASS | Real GitHub lookups accepted both artifacts |
| Separate local web tests/build | NOT RUN | Website source is unchanged; image workflows build the website |

[CI run](https://github.com/elewa-git/opencrane-new/actions/runs/44729079211),
[first application run](https://github.com/elewa-git/opencrane-new/actions/runs/44729067948),
[second application run](https://github.com/elewa-git/opencrane-new/actions/runs/44730045363),
and [scanner run](https://github.com/elewa-git/opencrane-new/actions/runs/44729074136)
all name the exact source commit above. The application workflows also completed
the existing native-image, licence, layer scan and authenticated-index checks.
No local candidate or builder-written record granted image approval.

Every local test, lint and typecheck ran under `nice -n 10`. Vitest used the shared
disposable database and at most two workers. No full root test suite ran locally.

## Rebase and earlier runs

Main advanced while the first checks ran. The rebase retained both the host checks
from PR #1169 and this slice's production sign-in checks. The approval lookup fix
from that merged PR is inherited unchanged; no second lookup fix was written.

I started the rebase before an earlier package repeat finished. That invalid run
ended with 610 passes and 33 failures caused by conflict markers. It is not passing
evidence. Both complete package repeats in the table ran after the rebase finished.

Before the rebase, the package scope passed 643/643 once, the token/bootstrap
suites passed 58/58 twice after the fix, and two image runs passed 17/17. Those
historical results do not replace the rebased checks. The
[original receipt](https://github.com/elewa-git/opencrane-new/blob/a61751de52c7526d7c8df9efd573670ffd61b2d8/docs/process/work-pilot-1113-s1/checks.md)
retains the original failing-first and fixture-correction evidence.

## Commands

Run the package command twice:

```sh
nice -n 10 node --experimental-strip-types --test --test-concurrency=2 \
  infra/package/preflight.test.mjs infra/package/chart.test.mjs \
  infra/package/chart-render.test.mjs infra/package/cnpg-install.test.mjs
```

Run the following twice with `PG_TEST_URL` set to the shared disposable database:

```sh
nice -n 10 npx vitest run infra/package/bootstrap.test.ts \
  apps/server/test/bootstrap-token.test.ts apps/server/test/bootstrap-claim.test.ts \
  apps/server/test/bootstrap-browser.test.ts --maxWorkers=2
```

Then run the remaining gates:

```sh
nice -n 10 npm run typecheck
nice -n 10 npm run check:events
nice -n 10 npm run lint:unused
nice -n 10 npm run lint:changelog
nice -n 10 npx markdownlint-cli2
nice -n 10 npm run lint:readmes
```

ESLint was invoked only on changed code files. Its ignored-file warnings remain
explicit in the table; no ignore or size limit was changed.

## Make it right

The fix adds only the branch that selects the correct completion message. Both
container checks reuse one named Docker invocation helper. The existing owner
assertions remain intact, and the token check requires owner setup to be absent.
Production functions changed by the slice remain within the stated size and
parameter limits. The merged README keeps both host checks and token ownership.

Shipped code: 257 added plus 34 deleted lines, 291 total. Tests, test fixtures,
documents, release notes and receipts are excluded. No dependency, event type,
public API field, SQL business rule, image pin or size limit was added or changed.
