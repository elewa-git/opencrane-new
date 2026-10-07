# Direct chat screen checks

P4-4, issue #86, stacked draft PRs #251 and #252. Both must land together.
The first chooses a recipient; the second adds sending and the transcript.
The regression specs and pending-send code make this feature larger than the usual
1,500-line target. Keeping the requested two-part stack avoids splitting its recovery
behaviour into a third change. No new dependency is added.

## API and frame states

| Frame | Source and behaviour | Available checks |
| --- | --- | --- |
| THR-05 | `GET /api/chat/colleagues?q=&limit=20` supplies names and member ids. Selecting a person creates nothing. The first send uses `POST /api/conversations` with exactly `{ id, conversationId, mode: 'direct', colleagueId }`. | Directory, draft, no-match, loading and failure captures. |
| THR-08 | The picker accepts one human colleague. There is no assistant choice, so a mixed recipient error cannot be reached through this screen. | Server rejects assistant and extra recipient fields. No fabricated capture. |
| THR-10 | History returns ordered `message.posted` rows with author, decrypted text, time and position. The socket subscribes after that history read. A 200 receipt says “Message recorded”; there is no delivery/read receipt. | Transcript, reload, scrolling and received-message announcement specs. |
| THR-11 | Lost create/message replies retain one pending record, its original text and ids. Check status sends one GET. A missing message status offers Send again with the same id. A 403 for a pending create keeps the text, says the chat was not created and offers Try again with the same ids. | Lost replies, missing records and repeated Enter specs; unknown and retry captures. |
| THR-12 | Direct messages use exactly `{ id, text }`; literal `@agent` stays human text. The screen exposes no assistant mode, model, attachment or Stop control. | Exact request/body and subscribe-only assertions, real-path request counters with positive controls, and literal text captures. |
| THR-16 | A genuine refused read clears names, drafts, pending changes, history and sockets. Late reads cannot refill them. | Access-loss and late-result specs and captures. |

HTTP 425 `{ status: 'access_applying' }` means the new conversation's permissions
are not ready for its recorded participant. The server checks active membership and
participants before reporting this state. Applied permission refusals, unknown ids,
nonparticipants and removed members still get 403. There is no bypass of access checks.

The first read and message post retry 425 with waits of 100, 200, 400, 800, 1600 and
1600 ms. The first message stays locked and in the same pending record throughout.
A bounded wait ends with its text kept and Check status available. A successful
permission check offers Send again and does not post the message itself. An
unavailable permission read says it could not be checked, rather than claiming
that permissions are still being applied. A 403 is never
retried as a temporary permission wait. A newer edit is cleared only if it matches
the text covered by the successful message receipt.

The pending record owns the phase, outcome, status-check flag, conversation id,
colleague id, original text and create/message references. Confirmed messages clear
that record. Two creates in one visit use fresh ids. Failed sends have a separate
failure string; history reads and refresh never replace it.

## Deliberate differences from the frames

| Difference | Reason |
| --- | --- |
| `/workspace/direct` has a separate screen. | It does not create the personal assistant session or expose turn controls. |
| The draft header says New conversation; its To card holds the colleague's name. | The first message creates the conversation. |
| A Refresh action remains in the header. | It reads the authorised list and the open history again. |
| The To card remains on open chats, with New chat. | It names the recipient and lets the person leave for a new draft. It never edits the existing participants. |
| Pending and failed-send notices sit immediately above the composer. | They stay beside the typed message on long chats. |
| The access-loss state uses the shared text notice. | It says what was cleared and has no actionable private information. It keeps the shared status styling rather than copying the frame's grey card. |
| The rail says People and Direct conversations. | This screen lists only authorised direct chats; assistant and group categories belong elsewhere. |
| Phones use a menu and docked composer. | The menu contains the conversation list. The desktop back link is hidden on phones to keep the header controls visible. |
| Drafts show no empty-message claim. | No conversation exists until the first send. Empty history appears only after a successful read. |
| No Delivered label, group mention notice, file or voice control appears. | The direct-message contract supplies human text and recorded events only. |
| Search shows at most 20 colleagues. | The directory is limited to 20 results per query. A visible hint asks for a narrower search; there is no next-page control. |

## Checks

All suites use `nice -n 10`. Server and root web tests use a throwaway PostgreSQL
17.6 container through `PG_TEST_URL`, plus their normal disposable service fixtures.
No full root suite or owner stack is used. The machine-readable capture list is
[`visual.json`](visual.json). Browser sample data does not qualify a fresh install.

| Check | Result | Evidence |
| --- | --- | --- |
| Rebase | PASS | Rebased onto the new #251 commit `fb029c8`; ancestry check returned 0. |
| Failing-first specs | PASS | 20 of the 33 focused web specs failed against the old screen. The new server permission-state spec returned 403 where 425 was required. |
| Focused web specs | PASS | All 39 focused specs and all 457 Angular specs pass with the guards restored. |
| Server permission specs | PASS | Both temporary access and removed-member specs passed. Removing the temporary-state, participant and membership guards made the corresponding specs fail. |
| Guard removal | PASS | 46 guard checks caused assertion failures, including real AI paths, temporary access, focus, font loading, draft ownership, scroll-up behaviour, 320 px clipping and link height. See [guards.json](guards.json). Guards were restored. |
| Visual browser check | PASS | 114 captures: 19 states at 1280/390/320 px and both motion settings. Control edges, sideways scroll, 44 px phone targets and the bottom of a 40-message transcript are checked. Zero turn and model requests. |
| Lint, typecheck, production build, event catalogue | PASS | Full lint and typecheck, production build and event catalogue passed. CSS warning budgets and the noVNC CommonJS warning remain below their error limits. |
| Chat server tests | PASS | Eight files, 79 tests, one worker, with the throwaway PostgreSQL database. |
| Root web tests | PASS | 12 browser/state/theme tests across three files. |
| Full Angular tests | PASS | 457 tests across 35 files, including 39 focused direct-chat specs. |
| Chat, F5, private-turn and screenshot visual checks | PASS | Chat Chromium checks; F5 18 captures; private-turn 24 captures; screenshot 63 captures. F5 checks the new link’s visible height. |
| Fresh-install direct-chat journey | NOT RUN | These checks use sample browser replies and disposable API fixtures, not a fresh-install journey. |

Long-chat captures contain 40 messages. The screen waits for fonts and the next frame
before scrolling, because font loading can change their heights. It checks the open
conversation and the person's scroll position again before moving the view. Lifecycle
events do not announce a received message. A recipient draft moves into the newly
created conversation, so opening another draft for the same person cannot restore
text that was already sent.

The initial expanded visual run passed 96 captures. Adding the 40-message phone check
caught a late font-height change. The final run includes that case and both bounded
permission-wait states. A failed first F5 link check queried the menu before it opened;
waiting for the visible link made that check measure the actual control.

The server’s access decision was split into a named helper to keep its complexity
within the lint limit. Both direct-chat files then passed all 20 tests again. The
full server run had already passed 79 tests across eight files. The root web run
passed all 12 browser, state and theme tests. The final full Angular run passed 457
tests. No required check remains failing.
