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
| MOD-11 | The key field supplies `key` to `POST /api/org/providers/:providerId/key`. | The example key and its validation error are not shown until a real validation error occurs. |
| MOD-12 | A pending key request is local UI state while the POST is in flight. | The key value is not echoed as bullets or copied to a receipt. The field remains write-only. |
| MOD-13 | `provider.key_saved` and the safe saved fact. A key save clears old reachability and model-answer evidence. | Saved time comes from the event; no person name is shown because the provider read omits it. |
| MOD-14 | `GET /api/org/providers/:providerId/verify?model=…` returns `priceTableId`, `reservedCents` and `consentRequired`. | The cost is read from the server quote. No example budget or fixed €0.01 price is invented. A real test requires explicit consent. |
| MOD-15 | `provider.verification_recorded` supplies the outcome, model, time, revision and settled cents. | This screen capture uses a local stub. It is not evidence that a real provider accepted a key. |
| MOD-16 | The `skip` verification action records a skipped model check. | “Connected, not tested” is shown only when reachability passed and model testing was skipped. It is never called Ready. |
| MOD-17 | A refused or failed verification response, including `unknown_price` when supplied. | No failure is shown until a refusal or failed result is returned. The API has no budget balance in the provider response. |
| MOD-18 | `GET /api/org/providers/:providerId/changes/:commandId` checks the original save command. | The command reference comes from the real request. The browser does not resend the key after a lost reply. |
| MOD-19 | Active registry `models` and provider `enabledModels`; saving writes `provider.models_selected`. | The route does not return design sample task-route labels or usage names. Existing `taskRouting` is shown separately. |
| MOD-20 | The provider response states `access.grantsAvailable: false` and `reason: p4_22_required`. | No member or assistant chips are shown. Access is labelled “Not available yet” until P4-22 supplies the grant contract. |
| MOD-21 | The safe saved, reachability, model-answer and model-selection facts already returned by the API. | Completion does not claim grant success, a working conversation or fallback behaviour. |
| MOD-25 | Key replacement writes a new `provider.key_saved` event at the expected revision. | The API has no retirement or upstream-key-revocation command. No old key is displayed. |
| MOD-26 | The original replacement command status, current revision and verification-valid flag. | The API does not report the name of a competing editor or when they changed it, so no named conflict is shown. |

## Checks

| Check | Result | Evidence |
| --- | --- | --- |
| Install | PASS | `nice -n 10 npm ci` completed. |
| Provider screen specs | PASS | 5 provider flow specs passed, including lost and invalid saves. |
| Web tests | PASS | 37 files and 443 tests passed. |
| Server provider route tests | PASS | `apps/server/test/providers.test.ts`: 56 tests passed. |
| Lint, typecheck and event catalogue | PASS | All three checks passed. |
| Angular build | PASS | `npm run build -w apps/web` completed; existing CSS budget and CommonJS warnings remain. |
| Responsive visual captures | PASS | 112 captures at 1280, 390 and 320px, with both motion settings. |
| F1-F5 checks | PASS | F1: 56, F2: 38, F3: 22, F4: 20 and F5: 18 captures passed. |
| Real provider key and paid model answer | NOT RUN | The visual script uses local responses. No paid call is made. |
