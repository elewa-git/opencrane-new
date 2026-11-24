# Packaged desktop viewing

Journey on a fresh dev stack: NOT RUN

## Fresh main package

**FAIL** on `6d9444cbe` at 1280 and 390 px. A signed-in owner opened a saved
conversation. **Watch your computer** showed **Unavailable** without the desktop
grant. After the grant, the ticket POST returned 200 at both widths. Chromium
then raised a constructor `TypeError` in `startViewer`, and the open dialog showed
**Disconnected** before any desktop frame.

The server passed both ticketed requests through the session and Origin checks,
recorded both start audits, and logged `disconnected` for both sessions. One
upgrade reached the server's WebSocket connection callback. The documented
dev-box host-risk switch was used for package startup. Package failure logs
were absent. The service logs were collected before the install was removed
and the slot released.

## Fixed package and dev stack

**NOT RUN**. The fixed package awaits CI and image approvals. The fresh CORE
journey is pending.
