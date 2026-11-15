# Fresh core journey

Date: 15 November 2026  
Source head: `bf59767a7fcc23a3053637aaf9f23024f95117fe`  
Stack: fresh secondary stack 2, started with `infra/dev-stack/up.sh --fresh`

## Journey

- PASS: Existing members and assistants retained model grant history, including explicit revocations.
- PASS: Owner and member signed in through Zitadel at 390 px; member sign-in passed at 1280 px.
- PASS: Logout refused hostile and missing origins while retaining the real session; `/auth/me` exposed no token.
- PASS: A token from the wrong organisation and an expired session were refused.
- PASS: Member join reached PostgreSQL, OpenFGA and the live WebSocket.
- PASS: New member and assistant model grants reached OpenFGA before chat.
- PASS: Browser chat at 390 px and 1280 px streamed a stub reply, reloaded without duplicates, and kept partial text after Stop and reload.
- PASS: Browser uploads at both widths passed ClamAV scanning, bounded turn context, previews and reload; EICAR, type and size refusals passed. Each width had one upload retry and no preview retries.
- PASS: Live view at 390 px and 1280 px refused viewing without a grant. With a grant, the real desktop and stub turn worked; revocation cleared pixels and audited Stop.
- PASS: Joined-member HTTP chat streamed through the projection; browser reconnect produced no duplicate reply.
- PASS: PDF scanning, bridge and MarkItDown delivered the expected text to the stub; EICAR was refused.
- PASS: A suspended computer woke on an HTTP message and completed a stub reply.
- PASS: Assistant and computer lifecycle join, resume and pod replacement kept the disk.
- PASS: The integrations endpoint returned event-derived rows and refused anonymous and member access.
- PASS: Audit showed the member's own turn and refused another member's and the owner's private history. Private text was absent from organisation history and logs.
- PASS: Paying-group and assistant budget ceilings saved at 1280 px and 390 px. Over-ceiling stub calls were refused and the saved ceilings remained after reload.
- PASS: Member and MCP catalogue projections replayed with verification.
- PASS: Token-boundary checks found no ID token in redirects, fetch, XHR, DOM or page cookies; process logs contained no ID token.
- PASS: Form sign-out reached Zitadel without a chooser or remaining session cookie; a no-session POST was refused. Reauthentication required credentials.
- PASS: Secondary stack listeners were limited to loopback.

## Refusal observations

- PASS: Live view refused the member before a desktop grant (`no grant refused`); after granting access, revocation cleared the pixels and recorded Stop.
- PASS: Both the paying-group and assistant budget checks refused an over-ceiling stub call. Each saved ceiling remained in place after reload at both widths.
- PASS: Wrong-organisation sign-in, expired-session access, hostile or missing logout origins, anonymous/member integrations access, EICAR upload and no-session sign-out were refused as described above.
- NOT RUN: Approval journey; the runner reports that it waits for the remaining #45 rows.

## Screenshots

- [Chat at 1280 px](chat-1280.png)
- [Chat at 390 px](chat-390.png)
