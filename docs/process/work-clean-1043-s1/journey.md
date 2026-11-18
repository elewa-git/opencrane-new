# Fresh CORE journey

Journey on a fresh dev stack: PASS

Date: 18 November 2026.
Tested head: `f5076116416ffc4ea39c0ce1292b31eb69c5b108`.
Environment: fresh secondary slot 1, loopback origin, stand-in model, Playwright
from the installed dependencies, 1280 px and 390 px. The production default
`systemClock` was active. The later commit adds receipts only.

Both secondary slots were free, no package stack was running, and the one-minute
load remained below 6 for more than five minutes before claiming the slot.
The [wait log](stack-wait.log) records the continuous observations.
No other qualification stack ran alongside this one.

## Steps and observations

1. PASS: claim slot 1, run `infra/dev-stack/up.sh --fresh`, then run status.
   Startup and status both returned 0. Setup enabled managed calls.
2. PASS at both widths: sign in, send a message, see the streamed stand-in reply,
   reload, then Stop another reply and retain its partial text after reload.
   Upload and preview PDF, text and image files. The attached PDF's project code
   reached the reply. Each width used one existing upload retry; no duplicate file
   was saved. Invalid type, size and scanner test files were refused.
3. PASS at both widths: open the conversation's computer panel. Access without a
   grant was refused. Grant access, view the real desktop, then revoke access.
   Pixels cleared in 287 ms at 390 px and 191 ms at 1280 px; the stop was audited.
4. PASS at both widths: read own action history and organisation metadata.
   Other-member private history was refused. Removing access cleared protected
   history. The process and gateway logs contained no private-text canary.
5. PASS at both widths: the owner sets a paying-group ceiling, then an assistant
   ceiling. The member sees the corresponding spending refusal, retained after
   reload. Restore headroom for later work.
6. PASS: verify replay for members and the tool catalogue. Check form sign-out,
   next sign-in and the ID-token boundary. Check secondary listeners stay on loopback.
7. PASS: copy all 37 screenshots into this receipt before teardown. Inspect their
   contents, including byte-identical copies, before publication. Run
   `infra/dev-stack/down.sh`: exit 0. Final status reports `free`.

The enclosing tool session reported 143 when collected. Its retained completion
record was already written: startup, status and teardown each returned 0, and the
released slot reported `free`. The [completion record](journey-result.json) keeps
those individual results. No additional journey result is inferred from the tool
session status.

The [CORE output](core-output.log) retains the successful assertions.
The [check receipt](checks.md) records the two test passes, all seven clock-source
mutation checks and the source-ready gates.

The standard CORE script skipped its separate approval journey. Paid-provider,
extended phase-4 and the remaining clock migration were NOT RUN by this slice.
The manual-clock tests prove elapsed access refusal; the browser journey proves
that the default real clock preserves the running product's CORE path.

## Screenshots

All screenshots were copied before teardown. Headroom restoration is captured at
390 px only. Duplicate chat images are retained because each CORE step wrote them.

| Screen | 1280 px | 390 px |
| --- | --- | --- |
| Chat and Stop | [View](screenshots/workspace-1280.png) | [View](screenshots/workspace-390.png) |
| Upload preparing | [View](screenshots/upload-preparing-1280.png) | [View](screenshots/upload-preparing-390.png) |
| Upload ready | [View](screenshots/upload-ready-1280.png) | [View](screenshots/upload-ready-390.png) |
| Uploaded PDF reply | [View](screenshots/upload-1280.png) | [View](screenshots/upload-390.png) |
| PDF preview | [View](screenshots/preview-1280.png) | [View](screenshots/preview-390.png) |
| Computer panel | [View](screenshots/live-view/conversation-entry-1280.png) | [View](screenshots/live-view/conversation-entry-390.png) |
| Granted desktop | [View](screenshots/live-view/conversation-viewer-1280.png) | [View](screenshots/live-view/conversation-viewer-390.png) |
| Revoked desktop | [View](screenshots/live-view/conversation-revoked-1280.png) | [View](screenshots/live-view/conversation-revoked-390.png) |
| Action history | [View](screenshots/history/fresh-action-1280.png) | [View](screenshots/history/fresh-action-390.png) |
| Organisation history | [View](screenshots/history/fresh-change-1280.png) | [View](screenshots/history/fresh-change-390.png) |
| History category | [View](screenshots/history/fresh-category-1280.png) | [View](screenshots/history/fresh-category-390.png) |
| History refusal | [View](screenshots/history/fresh-refused-1280.png) | [View](screenshots/history/fresh-refused-390.png) |
| History chat | [View](screenshots/history/fresh-stub-chat-1280.png) | [View](screenshots/history/fresh-stub-chat-390.png) |
| Group ceiling | [View](screenshots/spending/fresh-paying_group-1280.png) | [View](screenshots/spending/fresh-paying_group-390.png) |
| Group refusal | [View](screenshots/spending/fresh-paying_group-refusal-1280.png) | [View](screenshots/spending/fresh-paying_group-refusal-390.png) |
| Assistant ceiling | [View](screenshots/spending/fresh-assistant-1280.png) | [View](screenshots/spending/fresh-assistant-390.png) |
| Assistant refusal | [View](screenshots/spending/fresh-assistant-refusal-1280.png) | [View](screenshots/spending/fresh-assistant-refusal-390.png) |
| Spending chat | [View](screenshots/spending/fresh-stub-chat-1280.png) | [View](screenshots/spending/fresh-stub-chat-390.png) |
| Restored headroom | — | [View](screenshots/spending/fresh-repeat-headroom-390.png) |
