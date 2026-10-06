# Shared assistant admin screen check

This receipt covers the group admin screen in the first P4-7 change.

## What changed

Organisation admins can create a shared assistant for local and identity-provider
groups. A refused create keeps the typed name and selected grants. A lost reply keeps
the same command and assistant ids for status checks and a safe retry. A confirmed
create clears the form before the next one.

## Checks

| Check | Result | Evidence |
| --- | --- | --- |
| Rebase on `origin/main` | PASS | Rebased the two admin screen commits onto `f3096e8`. |
| Refused create spec guard | PASS | The spec failed when a POST 403 used the access-lost path. The resource-refusal path was restored. |
| Load retry spec guard | PASS | The spec failed when a successful retry did not clear the earlier load message. The clear was restored. |
| Web typecheck | PASS | `nice -n 10 npm run typecheck -w apps/web` |
| Web tests | PASS | `nice -n 10 npm run test -w apps/web -- --watch=false` |
| Angular build | PASS | `nice -n 10 npm run build -w apps/web`; existing CSS budget and noVNC module warnings remain. |
| Shared-assistant and group routes | PASS | `shared-assistant.test.ts` and `groups.test.ts`: 43 tests with the required throwaway PostgreSQL database. |
| Repository lint | PASS | `nice -n 10 npm run lint`; 9 existing max-lines warnings and two knip configuration hints. |
| Event catalogue | PASS | `nice -n 10 npm run check:events` |
| People screen visuals | PASS | `visual:p4-1-people`: 110 captures at 1280, 390 and 320 pixels, with both motion settings. |
| P4-7 visual checks | NOT RUN | The screen capture script is in the member-session change. |
| F1–F5 visual checks | NOT RUN | These run on the member-session change. |

## Limits

This check does not qualify a fresh installation or prove that a new computer has
finished provisioning. The page only shows facts returned by the server.
