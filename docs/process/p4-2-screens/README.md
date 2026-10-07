# Ownership screen receipt

This change covers the transfer review and confirmation screens. The API keeps the
ownership sequence and records each transfer on the ownership stream.

## Frame bindings and differences

| Frame | What the screen shows and why it differs |
| --- | --- |
| PPL-30 | Non-owner role changes belong to the People role work. They are not in this screen change. |
| PPL-31 | Non-owner role changes belong to the People role work. They are not in this screen change. |
| PPL-32 | `GET /api/ownership` supplies owner names, ids, sequence and viewer role. The API has no eligible member list or candidate names, so the screen asks for a known member id. `POST /api/ownership` sends `commandId`, `expectedSequence` and `successorId`; the server checks active membership. |
| PPL-32 | The page has a **Refresh owners** button in its heading. The frame has no refresh button. |
| PPL-32 | With one owner, the page shows a disabled **Step down** button and a note that another Owner must be appointed first. The frame hides Step down. |
| PPL-32 | Appointment uses two dialog steps, **Appoint an owner** and **Review successor**, with a **Back** button. The frame uses one dialog with a person's name. This API has no member directory, so the page asks for a member id the Owner already knows. |
| PPL-32 | A note explains that the page cannot show people who can be appointed. The frame offers a person picker, which this API does not provide. |
| PPL-32 | When the viewer is the last Owner, the page shows a notice below the owner list. The frame uses a card with a **Choose another owner** action. |
| PPL-33 | A confirmed `ownership.transferred` receipt supplies its command id, sequence, time and transferred member id. The current owner read supplies the two owner names. The API has no separate owner start date or actor display name. |
| PPL-33 | The page keeps **Appoint an owner** beside **Step down** after a transfer. The frame shows only Step down. The page lets an Owner make another transfer without leaving. |
| PPL-33 | The success message uses the new Owner's display name from the refreshed owner list. |
| PPL-33 | The change reference is the full command id from the 200 receipt. The frame uses a short reference, which this API does not provide. |
| PPL-34 | Step-down review is in the stacked follow-up. The server supports `ownership.step_down`; the first screen change does not show it. |
| PPL-35 | Detailed last-owner conflict, inactive-member refusal and Admin explanation are in the stacked follow-up. Unknown transfer replies keep their command id and only offer a GET status check. The API has no other pending change actor or start time. |

## Checks

| Check | Result | Evidence |
| --- | --- | --- |
| Web specs | PASS | `nice -n 10 npm run test -w apps/web` — 468 tests in 39 files. |
| Ownership route specs | PASS | 16 route and ordering tests with a throwaway PostgreSQL database. |
| Lint, typecheck and event catalogue | PASS | Root checks run under `nice -n 10`. |
| Angular build | PASS | `nice -n 10 npm run build -w apps/web` |
| Screen captures | PARTIAL | The capture script and all frame states are in the stacked follow-up. |
| Guard mutation proofs | PASS | The transfer screen specs failed when their guards were removed. The source was restored and the specs passed. |
| F1–F5 visuals | PASS | F1 56, F2 38, F3 22, F4 20 and F5 18 captures on the combined branch. |
| Fresh install journey | NOT RUN | Browser captures use replies supplied by the screen script. |
