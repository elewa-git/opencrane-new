# Ownership screen receipt

This change covers ownership transfer and step-down screens. The server records changes
with one ownership sequence and returns a reference for each change.

## Frame bindings and differences

| Frame | What the screen shows and why it differs |
| --- | --- |
| PPL-30 | Changes to member roles belong to the People role work. They are outside this screen. |
| PPL-31 | Changes to member roles belong to the People role work. They are outside this screen. |
| PPL-32 | `GET /api/ownership` supplies `owners`, `sequence`, `viewer` and `ready`. `POST /api/ownership` sends `action`, `commandId`, `expectedSequence` and, for a transfer, `successorId`. The server checks that a successor is active. It does not return a list of people who can be appointed. |
| PPL-32 | The page has a **Refresh owners** button in its heading. The frame has no refresh button. A read is safe while a change is unknown, so the button stays available then. |
| PPL-32 | With one owner, the page shows a disabled **Step down** button and a note telling the last Owner to appoint someone first. The frame hides Step down. |
| PPL-33 | After a transfer, the page keeps **Appoint an owner** beside **Step down**. The frame shows only Step down. The page lets an Owner make another transfer without leaving. |
| PPL-32 | Appointment uses two dialog steps: **Appoint an owner** and **Review successor**. The review names the typed member ID because the API has no directory. The frame has one dialog with a person's name. The second step also has a **Back** button. |
| PPL-33 | The success message uses the new Owner's display name from the current owner read. The frame shows a person's name, and this API provides it in that read. |
| PPL-33 | The change reference is the full command ID from the 200 receipt. The frame uses a short reference, which this API does not provide. The full value wraps on narrow screens. |
| PPL-32 | A note says that the page cannot show a list of people to appoint and asks for a member ID the Owner knows. The frame offers a person picker, which this API does not provide. |
| PPL-32 | When the viewer is the last Owner, the page shows a notice below the owner list. The frame uses a card with a **Choose another owner** action. The page keeps the action in the appointment flow instead. |
| PPL-34 | Step-down review says the viewer becomes an Admin and names the other current Owners. The server does not provide pending editors or their start times. |
| PPL-35 | A last-owner refusal names the rule. An inactive-member refusal names the typed ID and offers **Choose another owner**, keeping that ID in the field. The server does not provide other pending editors or their start times. |
| PPL-35 | An Admin can read the owner list but sees why owner changes are unavailable. A refusal that says the viewer is no longer an Owner refreshes the list and removes the Owner controls. |
| PPL-35 | A lost reply keeps its command ID and offers GET-only **Check status**. A 404 says that the server has no record yet and that the first request may still arrive. It also offers **Refresh owners**. The frame does not show this recovery path. |

## Checks

| Check | Result | Evidence |
| --- | --- | --- |
| Rebase | PASS | #262 was rebased onto `origin/main`; #263 was rebased onto the pushed #262 head. |
| Web specs | PASS | `nice -n 10 npm run test -w apps/web` — 512 tests in 40 files on the rebased #263 branch. |
| Ownership route specs | PASS | 16 ownership and ordering tests used a throwaway PostgreSQL database, which was removed. |
| Lint, typecheck and Angular build | PASS | Root lint and typecheck and the Angular production build ran under `nice -n 10`. Lint reported existing warnings only. |
| Ownership visual script | PASS | `nice -n 10 npm run visual:p4-2-screens` — 60 captures at 1280, 390 and 320 pixels, with motion on and off. |
| F1–F5 visual checks | PASS | F1 56, F2 38, F3 22, F4 20 and F5 18 captures passed on the rebased branch. F3's fixtures now match the current provider response. |
| Guard removal check | PASS | Removing the covered guards made 20 focused specs fail. Removing the sign-in message made its 401 spec fail. The source was restored and all 78 focused ownership specs passed. |
| Fresh-install journey | NOT RUN | Browser captures use intercepted replies and do not qualify a fresh installation. |
