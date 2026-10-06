# Private chat recovery captures

These browser captures show recovery, a lost reply and the memory-free choice.
The checks used 1280, 390 and 320 pixel viewports with normal and reduced motion.
At 320 pixels there is no handoff frame; that width checks that the controls fit.

Each row records one visible difference from the matching 1280 or 390 pixel frame.
The handoff includes a phone border and, in one frame, a keyboard. Browser captures
show the page itself and do not draw a phone or operating system keyboard.

| Frame | Capture | Difference | Why |
| --- | --- | --- | --- |
| THR-70 · 1280 | [recovering 1280](recovering-1280-no-preference.png) | The header says `earlier-question`, not `Sales assistant`. | The current workspace names a chat from its first message. |
| THR-70 · 1280 | [recovering 1280](recovering-1280-no-preference.png) | The header also labels the chat `Private session`. | Team chats now say who can see the turn. |
| THR-70 · 1280 | [recovering 1280](recovering-1280-no-preference.png) | The left rail shows current Shared and Personal sessions, not the handoff's sample people and groups. | The capture uses the current workspace navigation and a team session. |
| THR-70 · 1280 | [recovering 1280](recovering-1280-no-preference.png) | An earlier question and its completed reply remain above the lost request. | The earlier completed turn supplies the 10:01 confirmation time. The current view keeps that chat history. |
| THR-70 · 1280 | [recovering 1280](recovering-1280-no-preference.png) | The lost turn also shows `Reply failed` and `Didn't complete · nothing was repeated`. | The event history records the failed turn with no reply text. Showing its outcome avoids implying success. |
| THR-70 · 1280 | [recovering 1280](recovering-1280-no-preference.png) | The composer explains that sending is paused. It has no attach or microphone buttons. | Recovery disables sending, and a private team turn cannot attach shared files. |
| THR-70 · 390 | [recovering 390](recovering-390-no-preference.png) | The header uses the chat name and shows `Private session`. | The current mobile header keeps the team privacy label visible. |
| THR-70 · 390 | [recovering 390](recovering-390-no-preference.png) | The earlier completed exchange and the lost-turn outcome are visible. | The capture keeps the conversation history and reports the lost reply honestly. |
| THR-70 · 390 | [recovering 390](recovering-390-no-preference.png) | The composer shows a recovery message and no attachment controls. | Sending is paused while the computer recovers; private team turns have no attach control. |
| THR-71 · 1280 | [recovered 1280](recovered-lost-output-1280-no-preference.png) | The header names the chat instead of `Sales assistant`. | The current workspace derives the title from the conversation. |
| THR-71 · 1280 | [recovered 1280](recovered-lost-output-1280-no-preference.png) | The header also labels the chat `Private session`. | Team chats now say who can see the turn. |
| THR-71 · 1280 | [recovered 1280](recovered-lost-output-1280-no-preference.png) | The recovery notice says `Resumed on a fresh computer` without the 10:05 time. | The resumed state reuses the confirmed `SharedState` wording while its final design prompt is pending. |
| THR-71 · 1280 | [recovered 1280](recovered-lost-output-1280-no-preference.png) | The lost request and its failed outcome remain in the transcript. | The server keeps the original event history and does not replay the request. |
| THR-71 · 1280 | [recovered 1280](recovered-lost-output-1280-no-preference.png) | The memory warning says `The private memory checks have not all passed.` instead of `Private memory isn't loaded in this session.` | The fixture now uses the fixed server wording. Only loading private memory remains disabled. |
| THR-71 · 390 | [recovered 390](recovered-lost-output-390-no-preference.png) | The lost request and its outcome appear above the composer. | The current transcript keeps the event history and shows that no reply was repeated. |
| THR-71 · 390 | [recovered 390](recovered-lost-output-390-no-preference.png) | The header shows the chat name and `Private session`. | The current mobile header names the chat and keeps the team privacy label. |
| THR-71 · 390 | [recovered 390](recovered-lost-output-390-no-preference.png) | The composer has Private and Memory-free choices, with no attach control. | The current screen uses the private team composer rules. |
| THR-71 · 390 | [recovered 390](recovered-lost-output-390-no-preference.png) | The keyboard in the handoff is absent. | Playwright captures the browser page and cannot draw the phone's operating system keyboard. |
| THR-72 · 1280 | [memory-free choice 1280](memory-free-choice-1280-no-preference.png) | The current Shared and Personal session rail replaces the handoff's sample people and groups. | The capture uses the current workspace navigation. |
| THR-72 · 1280 | [memory-free choice 1280](memory-free-choice-1280-no-preference.png) | The header labels the chat `Private session`. | Team chats now say who can see the turn. |
| THR-72 · 1280 | [memory-free choice 1280](memory-free-choice-1280-no-preference.png) | The warning explains that a memory-free turn has no earlier context and writes to the shared disk. | The PR wording names the limits of a memory-free team turn. |
| THR-72 · 1280 | [memory-free choice 1280](memory-free-choice-1280-no-preference.png) | A `No messages yet` card appears below the warning. | The current empty-chat state remains available below the new memory warning. |
| THR-72 · 1280 | [memory-free choice 1280](memory-free-choice-1280-no-preference.png) | The composer offers Private and Memory-free and has no attach control. | Team turns stay private by default, and the memory-free button only changes the draft mode. |
| THR-72 · 390 | [memory-free choice 390](memory-free-choice-390-no-preference.png) | The header uses the chat name and shows `Private session`. | The current workspace keeps the privacy label on mobile. |
| THR-72 · 390 | [memory-free choice 390](memory-free-choice-390-no-preference.png) | A `No messages yet` card appears below the warning. | The current empty-chat state remains available below the new memory warning. |
| THR-72 · 390 | [memory-free choice 390](memory-free-choice-390-no-preference.png) | The composer shows Private and Memory-free choices instead of attach and microphone buttons. | Private team sessions do not attach files, and the memory-free choice stays unsent. |
| THR-72 · 390 | [memory-free choice 390](memory-free-choice-390-no-preference.png) | The warning adds that the memory-free turn has no earlier context and writes to the shared disk. | This states what changes when the person chooses the other turn mode. |
| THR-72 · 390 | [memory-free choice 390](memory-free-choice-390-no-preference.png) | The phone border from the handoff is absent. | The capture records the 390 pixel browser viewport without a device frame. |

| All three frames · 1280 and 390 | [private composer](recovered-lost-output-390-no-preference.png) | A composer footnote states that a private turn stays off the shared disk. The frames have no footnote. | The nearest line to the message field explains the mode before sending. It is also visible at 320 pixels. |
| Selected memory-free · 1280, 390 and 320 | [selected 1280](memory-free-selected-1280-no-preference.png), [selected 390](memory-free-selected-390-no-preference.png), [selected 320](memory-free-selected-320-no-preference.png) | The selected state adds a warning above the composer and changes its footnote to say that the turn has no earlier context and writes to the shared computer's disk. There is no selected-state frame. | This extra capture checks the wording at the point of sending. Choosing the mode keeps the draft unsent and focuses its field. |
| THR-70 · 1280 and 390 | [recovering 1280](recovering-1280-no-preference.png), [recovering 390](recovering-390-no-preference.png) | The lost-connection line is a red paragraph without the frame's cross icon. The recovery state has no surrounding box. | Both reuse the current notice component. They now sit after the last reply, as the frame does, and stay visible when the transcript scrolls to the bottom. |
| THR-71 · 1280 | [recovered 1280](recovered-lost-output-1280-no-preference.png) | Private and Memory-free choices replace attach and microphone icons. The rail is the current Shared and Personal rail. | Team turns have no attachment control. The rail uses the current workspace navigation. |
| THR-71 · 1280, 390 and 320 | [recovered 1280](recovered-lost-output-1280-no-preference.png), [recovered 390](recovered-lost-output-390-no-preference.png), [recovered 320](recovered-lost-output-320-no-preference.png) | Earlier context unavailable and Memory admission is disabled are plain lines rather than warm and grey cards. Their gap is smaller on phones. | The page reuses the existing shared states. The receipt records their current spacing and lack of card borders. |
| THR-71 · 1280 and 390 | [recovered 1280](recovered-lost-output-1280-no-preference.png), [recovered 390](recovered-lost-output-390-no-preference.png) | The notice omits `at 10:05` and `Your 10:02 request`. The request's 10:02 time remains in the transcript. | The feed has a loss time but no recovery time. The current notice describes this chat's last lost request without repeating its time. A healthy chat gets no lost-request notice. |
| THR-72 · 1280 and 390 | [choice 1280](memory-free-choice-1280-no-preference.png), [choice 390](memory-free-choice-390-no-preference.png) | The notice has an orange dot and a brown title instead of an information icon and bold dark text. Its detail omits the frame's second `Start a fresh memory-free turn.` sentence and the `newly checked` line. | The current needs-input state supplies the styling. The button already names the choice; the shorter detail describes its context and disk use without claiming checks that have not run. |

`visual.json` records all 24 captures. It checks recovery, lost output, both memory-free
states, no horizontal overflow, no button overlap at 320 pixels and 44 pixel phone buttons.
Finite animations finish before each capture. Memory-free turns are available as an
explicit choice. Loading private memory remains disabled until its checks pass.

## Source checks

The branch was rebased onto `origin/main` at `02b221a8fc660115495f64398cba17c6095909ea`.
The rebase completed, and that commit was checked as an ancestor of the branch.
All checks use lower CPU priority. Server and projection tests use a throwaway
PostgreSQL database through `PG_TEST_URL`; the full root suite is NOT RUN as requested. Both throwaway control databases were
removed with their volumes after the tests.

| Check | Result | Evidence |
| --- | --- | --- |
| Four blocking-state specs before the fixes | PASS | All four failed for the reported behaviour: selected footnote, queued mode, cold resume and a healthy chat's false lost-request notice. |
| Web guard-removal probes | PASS | The first 15 new web specs failed when the relevant guards were removed. The two-conversation spec failed in its separate probe. Separate probes caught the private default, the exact 10:01 confirmation time, lost composer focus, typed draft retention, Enter and two new conversations with distinct command ids. The receipt-status spec also failed before its fix and under its own guard-removal probe. Each change was restored. |
| Server guard-removal probes | PASS | Cold resume failed in the lifecycle, projection and HTTP specs. Separate probes failed for missing recovery data, lifecycle-history reads, assistant kind, lost list status and enabled memory admission. Each change was restored. |
| First selected-state phone visual check | FAIL | The existing phone rule hid the footnote. Team footnotes now remain visible, and all selected-state captures pass. |
| Lint | PASS | Code, dependency direction, unused code, Markdown, links and fixture checks passed. Existing function-length warnings remain. |
| Typecheck | PASS | Every workspace passed. |
| Event catalogue | PASS | All 96 registered event types match the catalogue. |
| Angular production build | PASS | The build completed. Existing CSS size and noVNC CommonJS warnings remain. |
| Web suite | PASS | 418 tests across 34 files. The two changed chat files also passed all 50 tests after their display helpers were moved. |
| Chat and private-turn server suites; computer projection specs | PASS | The 12-file batch passed 154 of 155 tests. The long-history follow-up POST returned 503 during that run. All five read-regression tests then passed in a single-worker rerun. No access limit or test was changed. |
| Direct chat regressions | PASS | 18 tests across two files passed after the list-query change. |
| Memory-admission evidence spec | PASS | The current incomplete evidence requires disabled memory admission. |
| Chat browser and F5 visual checks | PASS | Chromium checked keyboard, focus, touch targets, streaming, Stop/reload, offline Retry, wake state and scoped chat frames. F5 checked 18 captures at three widths and both motion settings. |
| Private chat visual checks | PASS | 24 captures at three widths with both motion settings. |
| Fresh-install live qualification | NOT RUN | These checks use local fixtures. They do not prove a live installation. |

The [guard probe record](guard-probes.json) lists the failed specs for each temporary
change. The four blocking-state specs also failed before their fixes were added.

| Behaviour checked | Removed rule that made the spec fail |
| --- | --- |
| Selected composer footnote | Replaced the memory-free footnote with the private text. |
| Queued message mode | Enabled the mode buttons and removed the private-choice lock. |
| Chat-specific lost-request notice | Showed it for every recovered computer. |
| Memory-free focus and announcement | Removed the move to the composer. |
| Recovery announcement | Removed the recovering-state announcement. |
| Recovery focus | Removed focus restoration after recovery. |
| Recovery placement and Stop | Moved recovery before the messages. A separate probe enabled the transcript Stop button during recovery. |
| Recovery Retry | Enabled the queued Retry button and removed the Send pause. |
| One memory-free turn | Removed the reset after its receipt. |
| Team private default | Set the selected team mode to memory-free. |
| Personal turn body | Removed the team-only execution-mode check. |
| Partial lost output | Treated every incomplete reply as having no text. |
| Lost output without completion | Kept that turn working, which made a Stop button appear. |
| Last confirmed time | Counted lost turns, which changed 10:01 to 10:04. |
| Chat switch | Kept the previous computer's recovered marker. |
| Lost reply reference | Removed the pending command reference. |
| Pending message and typed draft | Allowed a session change and cleared the draft without a successful send. |
| Healthy refresh | Returned failure after a successful read. |
| Recorded pending message | Skipped the command status read and sent again. |
| Send receipt | Accepted a 202 reply as if it were a 200 receipt. The spec failed before the fix and again with the guard removed. |
| Two fresh conversations | Kept the old conversation creation id. |
| Enter | Removed Enter submission. |
| Readable failure detail | Passed the raw reason code into the tool detail. |
| Cold resume | Ignored suspended and resumed events. |
| Stored recovery data | Dropped the recovered marker and loss time from the projection write. |
| Chat polling | Added a computer-history read to the feed path. |
| Assistant kind | Omitted assistant kind from the joined list row. |
| Lost list status | Reported a completed lost turn as Done. |
| Memory admission | Enabled memory admission while evidence remains incomplete. |

## Implementation details and limits

Computer recovery state, its last loss time and its recovered marker are stored in the
computers projection. Chat polls read that small PostgreSQL record. They never read the
whole lifecycle stream. Existing installations must rebuild this projection before
serving the updated chat routes; adding its columns alone does not fill older state.
Assistant kind is included in the existing list query.

The browser calculates the last confirmed time from loaded Done turns. A completed turn
with lost output does not count. This differs from the planned separate server field and
is also stated in the protocol notes. The recovered-computer notice appears only when
this chat's last agent turn was lost or failed at or after the computer's loss. A later
Done turn removes it. Recovery itself is explained in personal chats too.

A pending message keeps its command id, text, conversation and mode together. Its mode
buttons lock during sending and while queued. Retry checks the command's status before
resending with that same id. A confirmed reply clears the record so the next message
uses a new command. Memory-free applies to one turn and resets to Private after sending.
Recovery pauses both Send and Retry. Lost replies retain the typed draft and show the
command reference; they never claim the message was saved.

Memory admission remains DISABLED. This work does not change the private-turn live
qualification evidence or host conditions, and it adds no dependencies.

The whole feature exceeds the approximate 1,500-line aim. The extra lines keep the
original feature and add the required state and guard regression specs. No base test
was removed or weakened. No test, build or visual script for the base chat or F5 was
changed. Their generated comparison images were retained outside the worktree, rather
than adding unrelated capture changes to this PR.
