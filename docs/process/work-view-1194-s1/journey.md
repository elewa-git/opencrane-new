# Watch the computer and save a screenshot

The browser journey for viewing and capture was **PASS** on a fresh slot 1 stack
on 26 November 2026. It ran on commit `8c7ccb3e5` with the free stand-in provider.

1. A member accepted an invitation and signed in. They opened a personal assistant
   chat on the running stack.
2. At 390 and 1280 px, the member opened **Watch your computer** and saw the computer's
   800 × 600 desktop. They selected **Screenshot** and saw **Screenshot saved**.
3. The PNG appeared in the conversation and in the session panel. Its preview opened
   again after reload, and the downloaded bytes matched the saved SHA-256 digest.
   Each capture wrote one file record, and the computer had zero desktop grant events.
4. A second signed-in member opened the chat link at both widths. The website showed
   **This conversation isn't available**. The view, capture and file requests
   each returned HTTP 403.

| Viewport | Live view | Saved preview | Second member |
| --- | --- | --- | --- |
| 1280 px | [Viewing and screenshot saved](fresh-viewer-1280.png) | [PNG preview](fresh-saved-preview-1280.png) | [Chat unavailable](fresh-refused-1280.png) |
| 390 px | [Viewing and screenshot saved](fresh-viewer-390.png) | [PNG preview](fresh-saved-preview-390.png) | [Chat unavailable](fresh-refused-390.png) |

## Participant removal

The member was watching when their participation was removed. The socket closed,
the picture cleared and a new view request returned HTTP 403. The server
recorded `access_changed` as the stop reason in both runs.

| Viewport | Time to close and clear | Evidence |
| --- | --- | --- |
| 1280 px | 193 ms | [View after access ended](access-removed-1280.png) |
| 390 px | 129 ms | [View after access ended](access-removed-390.png) |

Fresh startup, the stack health check, the repeat journey and teardown passed.
The repeat removal check cleared both views within 300 ms.

The first two startup checks stopped on browser test assertions about the dialog
and the reason saved for a closed view. The final startup passed after the test
began measuring the socket and the picture. Startup and service logs from the
earlier runs were saved before teardown.
