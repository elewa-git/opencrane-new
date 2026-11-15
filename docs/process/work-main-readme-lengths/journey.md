# Fresh core journey

Date: 15 November 2026  
Source head: `a69177db3ad124ba99eeca2456fb4ebcb25fd6f2`  
Stack: fresh secondary stack 1, started with `infra/dev-stack/up.sh --fresh`

## Result

**PASS** — the fresh stack's core journey completed successfully. The PR changes
documentation only; it does not change product behaviour.

## Core steps

- PASS: Owner and member signed in through Zitadel; member join and model grants
  reached PostgreSQL, OpenFGA and the live WebSocket.
- PASS: Browser chat streamed a stub reply, reloaded without duplicates, and kept
  partial text after Stop and reload at 390 px and 1280 px.
- PASS: Browser PDF uploads passed scanning, text extraction, previews and reload;
  joined-member HTTP chat streamed a reply; a suspended computer woke and replied.
- PASS: Live view worked with a grant and cleared pixels after revocation at both
  widths. Assistant/computer lifecycle and disk recovery checks passed.
- PASS: Integration and audit views returned the permitted event-derived data;
  projections replayed with verification. Budget ceilings saved and refused
  over-ceiling calls at both widths.
- PASS: Token-boundary, process-log and loopback-listener checks passed. Sign-out
  and reauthentication completed.

## Refusals and unrun conditions

- PASS: Hostile or missing logout origins, wrong-organisation sign-in, expired
  sessions, anonymous/member integrations access and private-history access were
  refused.
- PASS: Live view without a grant, EICAR/type/size uploads and calls above the
  saved group or assistant ceilings were refused. Revocation cleared the view.
- NOT RUN: Approval journey; the runner is waiting for the remaining #45 rows.

## Screenshots

- [Chat at 1280 px](chat-1280.png)
- [Chat at 390 px](chat-390.png)

Both screenshots were copied from the fresh stack before teardown. The secondary
stack was then stopped with `infra/dev-stack/down.sh` (PASS).
