# Fresh core journey and probe gates

Date: 16 November 2026.

Journey source head: `ab137b6b3cfa0cf4c0bf7018a7d987252f5b3c4b`.
Base: `9e7579b504d702b0318ac9a93c006d8992789523`.
The following evidence commit adds documents, measurements and screenshots only.
Product source remained identical to the base throughout this probe.

Journey on a fresh dev stack: PASS (core journey; no product change).

## Fresh installation

PASS: Claimed secondary slot 1 through `infra/dev-stack/claim.sh`, exported its id
and referenced the existing Zitadel key by file path. A shell loop waited while
the one-minute load exceeded 10 before the claim. Ran exactly one core journey,
through `nice -n 10 infra/dev-stack/up.sh --fresh`, using the local model stub.
The entrypoint returned 0. Website readiness took 42.047 seconds.
The owner stack was not used.

## Observed journey

- PASS: Owner/member real Zitadel and PKCE sign-in at 390 px and separate member
  sign-in at 1280 px. Wrong-organisation and expired sessions were refused.
  Hostile and missing logout origins were refused without losing the valid session.
- PASS: Member join reached PostgreSQL, OpenFGA and the live WebSocket. Existing
  grant histories and explicit revocations remained; new grants arrived before chat.
- PASS: Browser chat at both widths streamed a stub answer, reloaded without
  duplicates, and preserved partial text after Stop and reload. First token took
  5,973 ms at 390 px and 3,430 ms at 1280 px; completion took 7,682 and 4,604 ms.
- PASS: Upload scanning, PDF extraction, bounded context, previews and reload
  without duplicate files at both widths. EICAR, type and size refusals passed.
  The unchanged runner recorded one upload retry and zero preview retries at each
  width, alongside `net::ERR_FAILED` transport messages. No retry was added here.
- PASS: Live view refused access without a grant. Granting access enabled the real
  desktop and stub turn. Revocation cleared pixels and audited Stop in 347 ms at
  390 px and 292 ms at 1280 px.
- PASS: HTTP chat streamed through the projection and browser reconnect kept one
  reply. PDF scanning and extraction supplied Willow-47; EICAR was refused.
- PASS: A suspended computer woke and completed a stub answer. Join, resume and
  pod replacement preserved its disk and uploaded text.
- PASS: Integrations returned event-derived admin rows and refused anonymous and
  member access. Audit showed own activity, refused other private history and
  kept private-text canaries out of organisation history and process logs.
- PASS: Paying-group migration was idempotent and preserved ceilings. Group and
  assistant ceilings saved at both widths; over-ceiling calls were refused and
  the saved ceilings remained after reload.
- PASS: Member and MCP catalogue projections replayed with verification.
- PASS: Redirects, fetch, XHR, DOM, cookies and five process logs exposed no ID token.
  Form sign-out reached Zitadel without a chooser or session cookie. A no-session
  POST was refused; another sign-in required credentials.
- PASS: Secondary listeners remained on loopback.
- NOT RUN: The core runner explicitly skipped the approval journey. Optional
  Phase 4 journeys and a real external model provider were not requested.

## Screenshots

PASS: Copied both images before teardown, verified their dimensions and visually
inspected each for private details. They contain only the test member and test chat.

- [Chat at 1280 × 900](chat-1280.png)
- [Chat at 390 × 844](chat-390.png)

## Own source checks

- PASS: Clean `npm ci` in this worktree and the requested NATS/Lychee symlinks.
- PASS: Fetch script installs the three pinned archives and exact Python packages
  into the local venv. The changed-checksum probe exited 1 before extraction with
  an existing installation; it was removed. The unmodified fetch and `pip check`
  passed. See the [probe receipt](probe.md) for licences and measurements.
- PASS: All three tools worked; hand CRAP 8.125 equals crapper's saved 8.125
  and rounds to its console 8.1. Mutation JSON reports prove assertion failures.
- PASS: Focused events tests, 35 files and 1,234 tests, with and without coverage.
- PASS: Workspace, package and dev-stack typecheck; Knip; changed-file ESLint with
  no warnings; check:events, with 174 matching types; unchanged package licence
  check; lint:changelog; Markdown lint. Knip retained two existing hints.
- PASS: No changed product-source lines, no new runtime tool references and no
  Python tool listed in any package.json. No automatic check, CI job or baseline.
- NOT RUN: Full root suite, full root ESLint and separate web tests, as requested.
  All tests, builds and CPU-heavy checks ran under `nice -n 10`.
- NOT RUN: Hosted CI results; this task stops after creating the draft PR.

No independent-review result is claimed in this receipt.

## Cleanup and publication

PASS: `nice -n 10 infra/dev-stack/down.sh` returned 0 and the slot status was
`free`. Both screenshots were already copied. Generated updates to shared journey
evidence outside this slice's folder were restored. Local tool snapshots
were moved under the ignored `.tools/clean-code/` directory; none is committed.
The worktree is retained for review.
