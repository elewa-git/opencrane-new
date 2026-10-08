# Fresh organisation journey details

The browser check lives in `infra/dev-stack/browser-phase4.ts` and runs from
`infra/dev-stack/journey.ts`. It runs only when the stack is secondary and the
journey has real signed-in browser sessions, and `P4_JOURNEY_ATTEMPT` names the
run. The owner stack, daily fresh run and runs without a browser do not run these
checks.

The check creates a group through the group page, adds the seeded member through
`POST /api/groups/:groupId`, and removes that member through the reviewed group
screen. The server has no command for granting a model to a group, so the check
adds that one event to the disposable stack event store. It creates a shared
assistant through its server command, starts a private session through the
member page, and waits for the local model stub's reply before saving screenshots.

The check creates a new group, assistant, provider and direct conversation on
every run. A saved-data run may open the previous direct conversation, so the
browser check first returns to a blank draft. Receipts and screenshots first live under
`$DEV_STACK_DIR/p4-journey/<attempt>/`. Copy them into this folder only after
the run has been recorded. The receipt includes the commit and the measured
Phase 4 run time.

## Live attempt record

The first two fresh starts passed at commit
`fd7a48add6948c3f93970a0c8ad7816f72247e91`. Their Phase 4 times were 48,461 ms
and 59,039 ms. Both starts completed the full stack journey.

| Attempt | Commit | Phase 4 result and time | What stopped the run |
| --- | --- | --- | --- |
| `fresh-1` | `fd7a48a` | PASS, 48,461 ms | Full start passed. |
| `fresh-2` | `fd7a48a` | PASS, 59,039 ms | Full start passed. |
| `repeat-1` | `fd7a48a` | NOT RUN | The journey check expected every model grant for a shared assistant, even though its event names only selected models. The saved-data check timed out before Phase 4. Fixed in `92b48277`. |
| `repeat-2` | `92b48277` | FAIL, 134,171 ms | The sixth computer had no disk because the stack allowed only five 1 GiB claims. The stack now allows six. |
| `recovery-fresh` | `b76fcfa` | PASS, 80,596 ms | Phase 4 passed. The full start then failed when a Zitadel login navigation aborted during browser cleanup. |
| `repeat-3` | `b76fcfa` | NOT RUN | The earlier chat check reported an uncertain send and timed out before Phase 4. The service log also recorded a worker timeout. |
| `repeat-4` | `b76fcfa` | FAIL, 58,636 ms | The desktop direct chat reopened the previous conversation instead of a blank draft. Fixed by starting a new draft. |
| `recovery-fresh-2` | `c3406bc` | FAIL, 84,342 ms | The direct chat page had not finished loading before the check searched for the colleague. A wait for the saved conversation list was added. |
| `repeat-5` | `31cc24c` | NOT RUN | Network changes stopped the earlier chat check before Phase 4. No Phase 4 receipt was written. |

The receipts for attempts that reached Phase 4 are next to this file. Each one
names the commit that ran and gives a status for every assertion it reached.
The two requested fresh receipts have all group, shared assistant, removal,
direct chat and provider save checks marked `PASS`. Ownership transfer and
separate member disks are `NOT PROVEN`; the paid provider answer is `PAID / NOT
RUN`. The saved-data repeat is still `NOT PROVEN` because no repeat completed
all its checks.

Zitadel setup succeeded on each start. The no-provider-response error from the
earlier run did not recur, so no five-minute setup retry was needed. All 176
copied screenshots were checked. None is a one-colour image or smaller than
5 KB.

Ownership transfer is attempted only on a secondary stack. The server accepts
that command only from a current Owner. The Zitadel test account is an Admin,
so the check records `NOT PROVEN` and does not add an ownership event to make
the account an Owner. Separate member disks and a paid provider answer remain
`NOT PROVEN` and `PAID / NOT RUN` respectively.
