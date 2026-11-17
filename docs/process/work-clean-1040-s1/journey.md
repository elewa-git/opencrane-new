# Test size report journey

Journey on a fresh dev stack: PASS (CORE journey)

Date: 17 November 2026. Tested head: `604f172503dc1e3218e4f70ea524396773fd5d3e`.
Fresh secondary stack: slot 1. Model: local stand-in. The branch was already based
on the fetched `origin/main` at `f5af2162b2fef5f52592de099c5819c137162e0a`.

## Rerun result

- PASS: `infra/dev-stack/claim.sh`, then `infra/dev-stack/up.sh --fresh` with
  `DEV_STACK_ID` set to the claimed slot and `ZITADEL_KEY_FILE` set by path.
- PASS: CORE journey on the fresh stack, including the 390 px and 1280 px chats.
  The 390 px browser chat streamed the stand-in reply; first token took 7,046 ms,
  completion took 9,646 ms and the browser journey took 106,788 ms. The 1280 px
  chat also passed; first token took 5,944 ms, completion took 6,813 ms and the
  browser journey took 97,990 ms. The joined-member HTTP chat and wake-up reply
  also passed.
- PASS: remaining CORE checks, including sign-in, uploads, live view, audit,
  organisation limits, replay and token/log boundaries. Approval journey was
  skipped because its required rows are not ready; this is not part of the CORE
  journey claim.
- PASS: `infra/dev-stack/down.sh` ran after the journey. A subsequent
  `infra/dev-stack/status.sh --id 1` reported `free`.

This rerun passed after the prior failed attempt below. It does not change that
earlier attempt's result. The stack's success output contained no model, gateway,
computer or timeout failure, so there are no failure logs to retain.

## Previous attempt

Journey on a fresh dev stack: FAIL

Date: 17 November 2026. Secondary slot: 1. Model: local stand-in.
Stack launch head: `ba068ea025e89f863b3fef0f982943e173dbe269`.
Report cleanup tested at `6a82a7f0f84e3e29561c267430d3ed1411baa666`.
Both heads have identical product and dev-stack source. No file under `apps` or
`libs` changed in this slice.

## Steps and results

1. PASS: claim a secondary slot through `infra/dev-stack/claim.sh` and start it
   with `infra/dev-stack/up.sh --fresh`, preserving the fleet marker.
2. PASS: provision services and wait for the website. Website readiness took
   39,062 ms. The queued `infra/dev-stack/status.sh` completed successfully and
   reported healthy HTTP services after the failed journey returned.
3. FAIL: the CORE journey used Playwright from the installed dependencies and
   signed in before opening the 390 px member chat. Sending the first greeting
   showed “Reply failed” and “Didn't complete · nothing was repeated”.
   The browser check timed out after 30 seconds waiting for `.caret` in
   `infra/dev-stack/browser-chat.ts:33`. No browser transport failures were recorded.
4. NOT RUN: completed chat, reload, Stop and the later CORE checks, including the
   1280 px chat screenshot. The first chat failure prevented reaching these checks.
5. PASS: run `infra/dev-stack/down.sh` through the launcher's EXIT trap after the
   failure and release the claimed slot.

[Observed chat failure at 390 px](chat-failure-390.png).
The product failure is outside this report-only change. This receipt does not
claim that the required fresh-stack journey passed.

## Source checks

- PASS: failing test commit `447546fa4` preceded implementation. All three pure
  function assertions failed against empty bodies for their expected reasons.
- PASS: all 57 CI-script tests twice; all five size-report tests twice again after
  the clarity cleanup. Tests cover classification, binary exclusion, the exact
  seven-day boundary, main-base selection, PR changes, summary output, a 10:1
  tree and Git errors that still exit zero.
- PASS: typecheck, event catalogue (174 types), knip, changelog, changed-file
  ESLint, Markdown, debt, dependencies, whole-stream reads, README checks, offline
  links, fixture boundaries and package licences. No new dependency was added.
- NOT RUN: full root tests and full local ESLint, as required by this task's local
  scope. CI runs the full lint. Web build and tests were not separately required;
  no web files changed, and the fresh stack built and served the website.
- PASS: the local report lists all 15 packages. Total source: 132,304 lines;
  tests: 243,775 lines; ratio: 1.8. The server source count is 37,389 lines.

The independent hand count was also 37,389, difference zero:

```sh
git ls-files 'apps/server/src/*.ts' 'apps/server/src/*.html' \
  'apps/server/src/*.css' ':!:apps/server/src/*.test.ts' \
  ':!:apps/server/src/*.spec.ts' -z | xargs -0 wc -l
```

Local report timings were 2.17 seconds without PR inputs and 2.02 seconds with
base and head inputs. Hosted summary and step duration: NOT RUN here; the builder
opens a draft and stops without waiting for CI. Those acceptance conditions remain
for the CI watcher, including the hosted limit of less than 15 seconds.

## Make it right

Reused `baseline.mjs` for the main merge base. Shared `classify` between file counts
and change totals, and shared the change accumulator between main history and PR
changes. Kept parsing, weekly allocation, ratios and formatting separate from Git
and filesystem access. Named intermediate values instead of chaining operations
or building values inside calls. No existing behaviour was replaced or deleted.
Every new function has at most five parameters and fewer than 80 counted lines.
The script adds 160 shipped-code lines. Tests, documentation and receipts are
excluded from that count; the workflow adds six lines. No size limits were raised.
