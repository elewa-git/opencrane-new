# Change history contracts

The organisation list reads `GET /api/org/history` with the existing type,
outcome, date, reference, decision, request and turn filters. `before` loads
the next page. Rows are keyed by audit id, even when recorded times match.

The selected row reads `GET /api/org/history/:auditId`. Its `before` field
pages bounded evidence. A link is drawn only from `taskHref` returned by
the server. The browser never builds a chat or child link from an event id.
The server checks publication and delegation chat rights for each read.
Memory details show only the allowed metadata.

A 503 leaves already loaded records visible with their last check time.
A 401 or 403 clears the list, detail and organisation navigation. Replies
from an older filter, closed detail or lost session cannot put them back.
Check status sends GET only.

`npm run visual:screen-p4-27-history` builds the website and captures
populated, empty and detail states at 1280 and 390 pixels with intercepted
API replies. It uses reduced motion and no development stack. Its receipt
is in `docs/process/screen-p4-27-history/`.
