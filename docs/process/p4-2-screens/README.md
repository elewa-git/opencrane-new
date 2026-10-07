# Ownership screen receipt

This change covers the transfer review and confirmation screens. The API keeps the
ownership sequence and records each transfer on the ownership stream.

## Frame bindings and differences

| Frame | What the screen shows and why it differs |
| --- | --- |
| PPL-30 | Non-owner role changes belong to the People role work. They are not in this screen change. |
| PPL-31 | Non-owner role changes belong to the People role work. They are not in this screen change. |
| PPL-32 | `GET /api/ownership` supplies owner names, ids, sequence and viewer role. The API has no eligible member list or candidate names, so the screen asks for a known member id. `POST /api/ownership` sends `commandId`, `expectedSequence` and `successorId`; the server checks active membership. |
| PPL-33 | A confirmed `ownership.transferred` receipt supplies its command id, sequence, time and transferred member id. The current owner read supplies the two owner names. The API has no separate owner start date or actor display name. |
| PPL-34 | Step-down review is in the stacked follow-up. The server supports `ownership.step_down`; the first screen change does not show it. |
| PPL-35 | Detailed last-owner conflict, inactive-member refusal and Admin explanation are in the stacked follow-up. Unknown transfer replies keep their command id and only offer a GET status check. The API has no other pending change actor or start time. |

## Checks

| Check | Result | Evidence |
| --- | --- | --- |
| Web specs | PASS | `nice -n 10 npm run test -w apps/web` — 455 tests in 39 files. |
| Ownership route specs | PASS | 16 route and ordering tests with a throwaway PostgreSQL database. |
| Lint, typecheck and event catalogue | PASS | Root checks run under `nice -n 10`. |
| Angular build | PASS | `nice -n 10 npm run build -w apps/web` |
| Screen captures | PARTIAL | The capture script and all frame states are in the stacked follow-up. |
| Guard mutation proofs | PASS | 12 focused specs and the browser focus check failed when their transfer guard was removed. Mutated source was restored. |
| F1–F5 visuals | PASS | F1 56, F2 38, F3 22, F4 20 and F5 18 captures on the combined branch. |
| Fresh install journey | NOT RUN | Browser captures use replies supplied by the screen script. |
