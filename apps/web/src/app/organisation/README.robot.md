# Organisation navigation contract

For people, read [README.md](README.md) first.

`overview.ts` reads `GET /api/org/overview` and preserves server row order.
The response has `rows`, `next`, `sources`, `viewer` and `capabilities`.
The page uses source names in place of people when the response has no authorised
person name. Publication and routines stay unavailable until their reads exist.
Ready rows appear in a separate evidence section only when their source is current
and both the source and row have valid dates. Provider rows use the safe id in
their supplied `/org/providers/:id` address. The action opens
`/org/models?provider=:id`, where the Models page shows that provider's row.
An empty current provider source shows Connect a provider. If every source is
current, the same screen also shows the dated Nothing needs your attention notice.

An invalid saved cursor restarts at page one once. A failed refresh keeps the
last loaded page and its checked time. A 401 or 403 clears rows and hides the
organisation navigation. A late reply cannot restore rows after refusal.
Actions map API evidence paths to browser pages; no API path is a page link.
Failed refreshes place the Refresh action in the stale notice and move keyboard
focus there when the earlier Refresh action had focus.

`npm run visual:p4-27-pr14` builds the website and captures twelve intercepted
states at 1280 and 390 pixels. The images and result are in
`docs/process/p4-27-pr14/`. They do not qualify a live installation.
