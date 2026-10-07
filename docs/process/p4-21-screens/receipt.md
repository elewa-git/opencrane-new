# Provider screens

This receipt records what the screens show from the provider routes and what is still
missing. Provider responses contain safe change facts. The browser never reads a saved
key back.

## Frame bindings

| Frame | What the screen reads or writes | Difference from the frame |
| --- | --- | --- |
| MOD-01 | `GET /api/org/providers` returns an empty `rows` list. | No sample organisation name, provider count or model count is shown. |
| MOD-02 | Provider `name`, `provider`, `saved`, `reachable`, `modelAnswer`, `enabledModels` and `status`; registry `models` and `taskRouting` from `/api/org/models`. | The table shows only API fields. It does not show saved-by names, assistant grants, people or usage totals. |
| MOD-02-RM | The same list fields as MOD-02 with reduced motion enabled. | Only the current page is shown. Static evidence does not animate. |
| MOD-03 | The last successful provider rows and their `loadedAt` value stay visible after a failed refresh. | The API has no stale-read state; the notice describes the browser's failed refresh. |
| MOD-04 | Provider reads require the Owner or Admin role. The screen shows the 403 refusal. | The route gives no safe refusal reason, so the screen says which role the route requires. Secret-service and gateway availability are not exposed by the list route. |
| MOD-05 | `saved`, `reachable` and `modelAnswer` facts from one provider row. | The API has no dependency counts or retirement route, so no “used by” counts or Retire action appear. |
| MOD-06 | The organisation shell's existing mobile navigation button and menu. | No provider data is added to the navigation menu. The close button has a 48px touch area. |
| MOD-10 | `POST /api/org/providers` records `provider.created` with `providerId`, provider name and revision. | The example provider name is not prefilled. The person enters a real name. |
| MOD-11 | The key field supplies `key` to `POST /api/org/providers/:providerId/key`. | The field uses password masking. A refused save keeps what was typed and shows the returned refusal. |
| MOD-12 | A pending key request is local UI state while the POST is in flight. | The key stays in its password field and is never copied to a receipt. A 200 response clears the field. |
| MOD-13 | `provider.key_saved` and the safe saved fact. A key save clears old reachability and model-answer evidence. | Saved time comes from `saved.time` and stays unchanged during refresh. No person name is shown because the provider read omits it. |
| MOD-14 | `GET /api/org/providers/:providerId/verify?model=…` returns `priceTableId`, `reservedCents` and `consentRequired`. | The cost is read from the server quote. No example budget or fixed €0.01 price is invented. Each request needs fresh consent to the current quote. A finished test hides the paid controls until Test again is chosen. |
| MOD-15 | `provider.verification_recorded` supplies the outcome, model, time, revision and settled cents. | This screen capture uses a local stub. It is not evidence that a real provider accepted a key. |
| MOD-16 | The `skip` verification action records a skipped model check. | “Connected, not tested” follows the server status. It is never called Ready and never replaces a failed or unknown result. |
| MOD-17 | A refused or failed verification response, including `unknown_price` when supplied. | Failed, budget-refused and unknown tests have separate captures and plain wording. The API supplies no budget balance or global-limit reason, so the screen does not invent either. An unknown test stays locked. |
| MOD-18 | `GET /api/org/providers/:providerId/changes/:commandId` checks the original save command. | The command reference comes from the real request. The browser does not resend the key after a lost reply, even after Enter. A 404 status read offers an explicit Start over; the person types a key again. |
| MOD-19 | Active registry `models` and provider `enabledModels`; saving writes `provider.models_selected`. | The route does not return design sample task-route labels or usage names. Existing `taskRouting` is shown separately. |
| MOD-20 | The provider response states `access.grantsAvailable: false` and `reason: p4_22_required`. | No member or assistant chips are shown. Access is labelled “Not available yet” until P4-22 supplies the grant contract. |
| MOD-21 | The safe saved, reachability, model-answer and model-selection facts already returned by the API. | Done includes the actual enabled-model count. It does not claim grant success, a working conversation or fallback behaviour. Go to Models closes the modal without reloading the app. |
| MOD-25 | Key replacement writes a new `provider.key_saved` event at the expected revision. | The API has no retirement or upstream-key-revocation command. No old key is displayed. |
| MOD-26 | The original replacement command status, current revision and verification-valid flag. | The API does not report the name of a competing editor or when they changed it, so no named conflict is shown. |

## Differences kept in the screens

| Screen choice | What the screen shows |
| --- | --- |
| Desktop setup | A centred modal, rather than the frame's panel on the right. |
| Setup progress | Numbered circles and “Step N of 6”, rather than ticks or the phone progress bar. |
| Verification facts | Three separate fact cards, rather than a single list with ticks. |
| Paid-test warning | Read current price and a consent box before Run priced test. Skip remains available before a paid attempt. |
| Provider list | Saved API connections only. No unsaved Anthropic placeholder or invented Not connected row appears. |
| Lost key reply | The unknown result appears inside the replacement modal. Its original reference also remains with the locked list row. |
| Budgets | The existing Spending link and tariff note remain on the page. The API gives no provider budget balance or global-limit reason. |
| Model access | The API says grants are unavailable. The screen shows that gap without people or assistant chips. |

## Checks on the provider list and key branch

These checks ran on the first branch. All lint, typecheck, builds and tests used
`nice -n 10`. Captures use intercepted responses and no real key.

| Check | Result | Evidence |
| --- | --- | --- |
| Rebase onto main | PASS | Rebase completed. Main at `bbb42e2` is an ancestor. The required checks were repeated after the last rebase and the protection for the final provider read. |
| Lint and typecheck | PASS | All lint stages and workspace typechecks completed. Existing function-size warnings remain. |
| Web suite | PASS | 460 tests passed at the final source, including all 17 provider specs. |
| Failing-first and guard removal | PASS | Lost key reply then Enter, Back then Next, seven server statuses, saved time, healthy refresh, two quick Enters, row focus and native submit each failed with its matching protection removed. All protections were restored. |
| Angular build | PASS | Build completed with existing bundle warnings. |
| Provider routes | PASS | 56 tests passed with local fake upstreams. An earlier run had a timeout and a 503; the separate rerun passed. |
| Event catalogue | PASS | All 98 event types match the catalogue. |
| Desktop and phone captures | PASS | Nine list, replacement and connect captures at 1280, 390 and 320 pixels. See `list-key-captures/`. |
| F1–F5 on this branch | NOT RUN | These scripts run on the second branch below. |

## Checks on the verification and model branch

The second branch is based on the pushed first branch. Every original provider
spec remains. The tests use local responses, including paid-test results. They
never make a paid request.

| Check | Result | Evidence |
| --- | --- | --- |
| Rebase onto main | PASS | After #259 merged, both #260 commits were rebased onto `origin/main`; the rebase completed and main is an ancestor. |
| Provider screen specs | PASS | All 59 provider screen specs passed. They cover exact verification bodies, fresh consent, unknown locks, free-check recovery, key refusal wording, Anthropic setup, refusals, focus, modal announcements, stale reads, secret clearing and model choices. |
| Failing-first and guard removal | PASS | The added consent spec failed when the clear-at-send line was removed, then passed after the line was restored. Earlier guard checks remain in [guard checks](guard-checks.json). |
| Strict visual contract | PASS | Nine invalid request shapes failed against a permissive stub. Three valid shapes failed when refused. Restoring the real-schema checks returned all 12 to green. No request is made by these specs. |
| Web suite | PASS | 38 files and 502 tests passed. |
| Provider routes and visual contract | PASS | 68 tests passed, including the 56 real-route cases with local fake upstreams. Reachability and skip exercise the real route without a paid provider. |
| Lint | PASS | Every root lint stage completed, with nine existing function-size warnings. |
| Typecheck | PASS | All workspace typechecks passed, including the web app, specs and live-view fixture. |
| Event catalogue | PASS | All 98 registered event types match the catalogue. |
| Angular build | PASS | The final production build completed. Existing CSS budget and noVNC CommonJS warnings remain. |
| Responsive visual captures | PASS | 130 captures at 1280, 390 and 320 pixels with both motion settings. Overflow, 44px targets, button contrast and one live status region were checked. Budget refusal, failure and unknown each have six captures. Unknown status checks send no POST. |
| F1–F5 | PASS | F1: 56, F2: 38, F3: 22, F4: 20 and F5: 18 captures passed. F2 initially matched the new direct-chat link as well as Ask; selecting the Ask button kept the original focus check and passed. |
| Focused consent spec after guard restoration | PASS | The 409 refusal spec failed when the clear-before-send line was removed. All 59 provider screen specs passed after it was restored. |
| Screen reader journey | NOT RUN | Specs check modal status regions and browser captures check their placement. No assistive-technology session was run. |
| Fresh-install provider journey | NOT RUN | No owner credentials were used. These checks do not qualify a fresh installation. |
| Real key and paid model answer | NOT RUN | No real key was entered and no paid upstream was called. |

## Review notes still open

| Note | Status | Detail |
| --- | --- | --- |
| Shared verification parser | NOT DONE | The visual fixture uses the real body schema, but it still repeats the route's provider-id rule. A shared parser could keep the fixture and route in step. |
| Projection timing | NOT DONE | A provider list read can arrive before a verification result reaches the projection. The screen then shows an unknown result until Check status is used. |
| Real free checks | NOT RUN | An owner still needs to try reachability and Skip against a real provider route. No real key or paid model test is part of that check. |
