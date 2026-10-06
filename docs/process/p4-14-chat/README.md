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
| THR-71 · 1280 | [recovered 1280](recovered-lost-output-1280-no-preference.png) | The memory warning says `qualification incomplete`. | The server shows the current evidence reason while memory admission stays disabled. |
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

`visual.json` records all 18 captures and the checks for recovery, lost output,
the unsent memory-free choice and horizontal overflow. The memory-free option
remains disabled until the private-turn evidence passes its checks.
