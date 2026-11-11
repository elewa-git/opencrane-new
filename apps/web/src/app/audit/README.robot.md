# Change history contracts

The organisation list reads `GET /api/org/history` with type, outcome, date
and reference filters. Search submits the safe reference. `before` loads
the next page. Rows are keyed by audit id, even when recorded times match.
The family filter sends `members`, `tools`, `spending`, `memory` or `routines`.
The server maps each key to the event prefixes in that family before paging.

The selected row reads `GET /api/org/history/:auditId`. Its `before` field
pages bounded evidence. A link is drawn only from `taskHref` returned by
the server. The browser never builds a chat or child link from an event id.
The server checks publication and delegation chat rights for each read.
Memory details show only the allowed metadata.
Routine list titles use the saved `routineState`. Detail headings use the saved
routine event type, including due, skipped, admission, Stop, uncertain send and
finish. These labels contain no routine instructions, scopes or model output.
The screen shows a short change reference only when the server id is a safe
`chg_` reference. Other internal ids stay out of the list and detail.
The detail opens as a browser modal. At phone widths it covers the full
viewport and its task action spans the available width. The browser keeps
keyboard focus inside it, and Escape returns focus to the selected row. A person actor on an
authoritative record is shown as a verified person without exposing an id.
An ownership record is called confirmed only when both content and access
progress are current. The People & groups link opens the normal access-checked page.

A 503 leaves already loaded records visible with their last check time.
A 401 or 403 clears the list, detail and organisation navigation. Replies
from an older filter, closed detail or lost session cannot put them back.
Check status sends GET only.

`npm run visual:screen-p4-27-history` builds the website and captures
populated, empty, membership detail, routine detail and routine list states at 1280 and 390 pixels with intercepted
API replies. It uses reduced motion and no development stack. Its receipt
is in `docs/process/screen-p4-27-history/`.
