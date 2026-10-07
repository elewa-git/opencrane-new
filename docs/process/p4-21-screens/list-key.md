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

## Checks

| Check | Result | Evidence |
| --- | --- | --- |
| Install | PASS | `nice -n 10 npm ci` completed. |
| Provider list and key specs | PASS | Five specs passed, including two creates, Enter, a lost reply and a refused save. |
| Angular build | PASS | `nice -n 10 npm run build -w apps/web` completed. |
