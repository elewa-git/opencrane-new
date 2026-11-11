# Memory browser contracts

For people, read [README.md](README.md) first.

The trail uses the authorised scope from the existing Memory tab. It reads the
bounded `/maintenance` pages and opens `/maintenance/:runId` only from a clicked row.
Load more sends the saved cursor once and appends unique rows in page order.
Check status rereads the selected original id. Neither action sends a command.

Run `npm test -w apps/web -- --watch=false --include=src/app/memory/maintenance-trail.spec.ts`
for focused browser behaviour. Run `npm run visual:screen-p4-17-trail` to build the
website and capture six intercepted screens at both widths.

The landed detail reply gives the saved action, intended/selected/recorded times,
member and accepted allowance for a prepared row. It currently gives no actual
start, source links or joined held/settled money. The browser labels these values
unavailable. It never treats an allowance, root or pending reply as a charge or
successful fact change. It does not use the current binding as an older run's
assistant or payer.

Read failures keep safe loaded rows and offer another GET. A 401, 403 or 404 clears
rows and detail. Scope, requester and access changes abort old reads and clear RAM;
restored access starts a fresh read. The shared dialog handles focus, Escape and
phone layout. No trail data goes into URLs beyond the authorised route or storage.
