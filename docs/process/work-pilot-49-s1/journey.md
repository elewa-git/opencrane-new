# Personal tool keys: browser receipt

Journey on a fresh dev stack: FAIL

Run on 12 November 2026 using source commit `ac877d7f9`. The requested personal-key
steps below passed on a fresh secondary stack. The complete fresh-stack startup
qualification failed separately: its existing live-view journey timed out waiting
for `.caret` in `browser-live-view.ts`. This run does not qualify the capability
for merge. No failure was treated as a pass.

## Review repair qualification

Live rerun on the repaired source: NOT RUN. The fresh-stack rerun waits for the
main journey repair to land, as requested. No secondary stack was claimed for
these repairs. The earlier slice steps at 1280 px and 390 px remain the only live
personal-key evidence; the complete startup qualification above remains FAIL.

Journey-visible changes: none to the review controls, key form or displayed
messages. Malicious identity replies that encode the submitted key are now
refused before custody staging or append. Refusal JSON adds fixed `reason`
labels, and server logs classify causes without recording private messages.

Own source checks on 13 November: PASS. All commands ran under `nice -n 10`.
The 32 route, identity, review and account tests and six focused custody tests
passed twice. The five browser tests passed twice. The 21 dispatch credential
checks and two selected-call and missing-key notice regressions passed. All 39
stack-claim fixture tests passed, followed by a repeat of the four changed cases.
The full root test suite was NOT RUN.

Guard checks: PASS. Hand-authored mutations disabled each listed HTTP, policy,
reply-id, review-choice, account, profile, revision, stored-material and input
clearing guard. Each isolating test failed, then passed after restoration.
Removing causal diagnostics also failed all four failure-classification tests.
No mutation remains in the source.

Gates: PASS for workspace, package and dev-stack typecheck; the model typecheck
again after making an unused helper private; event catalogue (174 types); Knip;
changelog lint; changed-file ESLint; and Markdown lint. ESLint reports one existing
size warning in the untouched `mcpDispatch` function. No added or changed function
has a warning. Knip reports two existing configuration hints.

## Setup and limits

Claimed secondary slot 1 through `infra/dev-stack/claim.sh`, then ran
`infra/dev-stack/up.sh --fresh` and inspected its status. Used Playwright from the
worktree against that slot, with real sign-in and product commands. The owner stack
was not used. The browser checks used 1280 px and 390 px viewports and checked that
the pages fit without horizontal scrolling.

Used `apps/demo-mcp` in credential-checked mode with two synthetic accounts and
caller-supplied test keys held outside the repository. The existing guarded local
TLS fixture supplied transport to that actual server. Its free model requested a
real tool call and included the returned `actedAs` value in its reply. No browser
API responses were replaced. The result is a local fixture qualification; an
external provider and a paid model were not tested.

## Observed steps

1. PASS: the admin installed the demo server, selected “needs a personal key”, chose
   read-only `who_am_i`, reviewed its tools, published and granted access to the
   members and assistants used here. An expired review snapshot was refused; the
   admin refreshed the review and confirmed the current snapshot.
2. PASS: member A submitted an invalid key. Identity verification refused it, the
   input cleared, and no usable profile was created.
3. PASS: member A saved their key through My tools, saw account A verified and
   selected it. A return visit loaded the saved profile as verified and selected.
   An earlier connection-list read failed; the later return visit succeeded. The
   form was empty in every screenshot.
4. PASS: member A sent a live turn. `read_fixture_quote` completed and the reply
   reported “Acted as account-a”, with zero recorded effects.
5. PASS: member B, who had no saved key, saw “Connect your key in My tools” in a
   shared assistant session without a personal default assistant. B completed a
   normal live turn with no demo tool call. The notice remained; its link opened
   My tools, which reported no saved connections and offered an empty key form.
   The assertion that the server's tools are excluded from the turn offer is
   covered by the product-command tests; the browser observations alone do not
   inspect the model's offered tool list.
6. PASS: a later live catalogue read still showed `accountMode: personal`,
   `identityTool: who_am_i`, published and no drift hold. Its last catalogue check
   was at 23:04 UTC, after the earlier review and tool call. Replay from the start
   of the log was tested through product commands, not through this browser run.
7. PASS: closed the browser and stopped the fixture. Ran
   `infra/dev-stack/down.sh` for the claimed slot. Kept the worktree for review.

## Screenshots

| Step | 1280 px | 390 px |
| --- | --- | --- |
| Admin review | [Review](review-1280.png) | [Review](review-390.png) |
| Identity refusal | [Refusal](identity-refused-1280.png) | [Refusal](identity-refused-390.png) |
| Empty key form after return | [Key form](key-verified-1280.png) | [Key form](key-verified-390.png) |
| Verified and selected account | [Account](selected-account-1280.png) | [Account](selected-account-390.png) |
| A's live tool result | [Account A](account-a-turn-1280.png) | [Account A](account-a-turn-390.png) |
| B's completed turn and notice | [Missing key](missing-key-1280.png) | [Missing key](missing-key-390.png) |
| B's linked empty form | [No saved key](no-saved-key-1280.png) | [No saved key](no-saved-key-390.png) |

## Source checks

- PASS: failing tests were committed and observed failing before implementation.
  Marking, catalogue re-check, replay and both turn outcomes use product commands.
- PASS: changed acceptance tests ran twice. The wider custody and product batch
  passed 668 tests; the final legacy/control batch passed 45 tests. The live
  bridge regression passed 9 tests against the image built from this worktree.
- PASS: full web suite, 82 files and 1,560 tests; repeated workspace suite, 114
  tests; production web build and web typecheck.
- PASS: repository typecheck, event catalogue (174 types), event field security
  tests (482), Knip, dependency boundaries, changelog lint, changed-file ESLint and
  Markdown lint. ESLint reports three existing warnings in untouched functions;
  no warning remains in a function added or changed here.
- PASS: manually removed the pre-identity access check, final append access check
  and identity-verification guard separately. Each corresponding test failed;
  restored each guard and observed the tests pass.
- NOT RUN: an external provider, a paid model, company-account turns and personal
  assistant restrictions. The last two belong to other tickets.

## Make it right

Shared the verified-personal-account decision across selection, turn context and
credential release. Reused the existing key custody, identity-change block,
profile statuses and authority checks. Split checked key saving, conditional
append and turn-tool readers by responsibility. Removed duplicated credential
pattern and account comparisons. Kept default demo behaviour covered by its
existing tests and catalogue digest.

The application source diff is 1,486 added lines and 390 removed lines, excluding
tests and documents. It includes moved helpers. The larger slice also needs the
previously missing key form, identity verification and demo credential mode to
make the requested browser journey reachable. Development-stack fixture changes
are additional. The 1,876 changed application lines exceed the owner's accepted
estimate of about 1,210–1,590. This draft needs an explicit owner size decision
before landing; the estimate is not reported as met. No new dependency or
size-limit override was added.
