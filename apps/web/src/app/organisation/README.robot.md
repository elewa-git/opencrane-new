# Organisation navigation contract

For people, read [README.md](README.md) first.

`overview.ts` reads `GET /api/org/overview` and preserves server row order.
The response has `rows`, `next`, `sources`, `viewer` and `capabilities`.
The page uses source names in place of people when the response has no authorised
person name. Publication and routines stay unavailable until their reads exist.

An invalid saved cursor restarts at page one once. A failed refresh keeps the
last loaded page and its checked time. A 401 or 403 clears rows and hides the
organisation navigation. A late reply cannot restore rows after refusal.
Actions map API evidence paths to browser pages; no API path is a page link.

`npm run visual:p4-27-pr14` builds the website and captures twelve intercepted
states at 1280 and 390 pixels. The images and result are in
`docs/process/p4-27-pr14/`. They do not qualify a live installation.
