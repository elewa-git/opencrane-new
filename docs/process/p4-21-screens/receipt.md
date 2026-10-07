# Provider list and key receipt

This receipt records what the provider list and key screens read and write.
The browser never reads a saved key back.

## Frame bindings

| Frame | What the screen reads or writes | Difference from the frame |
| --- | --- | --- |
| MOD-01 | `GET /api/org/providers` returns an empty `rows` list. | No sample organisation name or provider count is shown. |
| MOD-02 | Provider `name`, `provider`, `saved`, `reachable`, `modelAnswer`, `enabledModels` and `status`. | Only API fields appear. Saved-by names and usage totals are not available. |
| MOD-02-RM | The same provider fields as MOD-02 with reduced motion enabled. | Static evidence does not animate. |
| MOD-03 | The last provider rows and `loadedAt` remain after a failed refresh. | The API has no stale-read state. The notice describes the failed browser refresh. |
| MOD-04 | The provider route requires Owner or Admin. The screen shows the 403 refusal. | The route gives no safe refusal reason. Secret-service and gateway health are not shown here. |
| MOD-05 | `saved`, `reachable` and `modelAnswer` appear as separate facts from `IntegrationFacts`. | The API has no dependency counts or retirement command. |
| MOD-06 | The organisation shell's existing mobile navigation button and menu. | The close button has a 48px touch area. No provider data is added to the menu. |
| MOD-10 | `POST /api/org/providers` records `provider.created`, the name and revision. | The person enters a real connection name. |
| MOD-11 | The password field supplies `key` to `POST /api/org/providers/:providerId/key`. | The key is never echoed or copied to a receipt. |
| MOD-12 | Local pending state while the key request is in flight. | The field remains write-only. A lost reply keeps the typed value for status checking. |
| MOD-13 | `provider.key_saved` and its safe saved fact. | The event has no saved-by name, so the screen does not invent one. |
| MOD-18 | The original save command is read at `/changes/:commandId` after a lost reply. | The browser never resends a key after an uncertain reply. |
| MOD-25 | Replacement writes a new `provider.key_saved` event at the expected revision. | The API has no command to revoke the old key at the provider. |
| MOD-26 | The original replacement command status and current revision. | The API does not report a competing editor's name. |

## Differences kept in the screens

The setup uses a centred modal on desktop. Key replacement shows an uncertain
save inside that modal. The list uses separate saved, reachability and model-answer
facts. Saved times come from the saved fact, not the time of the latest refresh.

## Checks

All checks ran with `nice -n 10`. Captures use intercepted replies only.

| Check | Result | Evidence |
| --- | --- | --- |
| Rebase onto main | PASS | Rebase completed; `origin/main` is an ancestor of the branch. |
| Lint | NOT RUN | Final check is still running. |
| Typecheck | PASS | All workspaces completed; the final web check also completed. |
| Web suite | PASS | 453 tests passed; the final provider run passed all 16 specs. |
| Failing-first and guard removal | PASS | Lost key reply then Enter, Back then Next, all seven status labels, saved time, healthy refresh, two quick Enters, focus return and native submit each failed with the matching protection removed. All protections were restored. |
| Angular build | PASS | Build completed with existing bundle warnings. |
| Provider routes | PASS | 56 tests passed with local fake upstreams. An earlier run had one timeout and one 503; the separate rerun passed. |
| Event catalogue | PASS | All 98 registered event types match the catalogue. |
| Phone and desktop captures | PASS | Nine list, replacement and connect captures at 1280, 390 and 320 pixels; no horizontal overflow. See `list-key-captures/`. |
| F1–F5 | NOT RUN | These regression scripts run on the second branch. |
| Fresh-install provider journey | NOT RUN | No owner credentials or paid provider request was used. |
