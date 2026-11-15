# Fresh core journey and checker evidence

Date: 15 November 2026

Source head: `7b82633924e3ceca83376617be703176a612809a`

Stack: fresh secondary stack 1, claimed with `infra/dev-stack/claim.sh` and started
with `infra/dev-stack/up.sh --fresh` using the local model stub. The load was 4.64
when the stack was claimed and rose to 13.70 during the journey.

Startup began at the source head above. The product source stayed identical
throughout; the diff against origin/main contains zero changed lines under `apps/`
and `libs/`.

## Journey

Journey on a fresh dev stack at the rebased source head: PASS (core journey; no product change).

- PASS: Existing members and assistants retained model grant history, including revocations.
- PASS: Owner and member signed in through Zitadel and PKCE at 390 px; member sign-in
  also passed at 1280 px in a separate browser context.
- PASS: Hostile and missing logout origins were refused without losing the real
  session. A wrong-organisation token and an expired session were refused.
- PASS: Member join reached PostgreSQL, OpenFGA and the live WebSocket. New member
  and assistant model grants reached OpenFGA before chat.
- PASS: Browser chat at 390 px and 1280 px streamed a stub reply, reloaded without
  duplicates and retained partial text after Stop and reload. First token took
  8,012 ms at 390 px and 2,913 ms at 1280 px; completion took 8,878 ms and
  4,616 ms respectively.
- PASS: Uploads at both widths passed scanning, bounded turn context, previews and
  reload without duplicate files. EICAR, type and size refusals passed. The runner
  reported one upload retry and zero preview retries at each width.
- PASS: Live view at both widths refused access without a grant. A grant enabled
  the real desktop and stub turn; revocation cleared pixels and audited Stop.
  Revocation took 249 ms at 390 px and 358 ms at 1280 px.
- PASS: Joined-member HTTP chat streamed through the projection and browser reconnect
  produced no duplicate reply. PDF scanning, bridge and MarkItDown supplied the
  expected text to the stub; EICAR was refused.
- PASS: A suspended computer woke on an HTTP message and completed a stub reply.
  Assistant and computer join, resume and pod replacement preserved the disk.
- PASS: Integrations returned event-derived rows and refused anonymous and member access.
- PASS: Audit showed a member's own turn and refused another member's and the owner's
  private history. Organisation history and process logs contained no private-text
  canaries; the member could not read organisation history.
- PASS: Paying-group migration was idempotent and preserved existing ceilings.
  Paying-group and assistant ceilings saved at both widths. Over-ceiling stub calls
  were refused, and the saved ceilings remained after reload.
- PASS: Member and MCP catalogue projections replayed with verification.
- PASS: Redirects, fetch, XHR, DOM, page cookies and five process logs exposed no ID token.
- PASS: Form sign-out reached Zitadel without a chooser or remaining session cookie;
  a no-session POST was refused. Reauthentication required credentials.
- PASS: Secondary-stack listeners were limited to loopback.
- NOT RUN: Approval journey. The core runner explicitly skips it while remaining
  approval work is unfinished. No optional Phase 4 journey was requested.

## Screenshots

Both images were copied before teardown and visually inspected for private details.

- [Chat at 1280 px](chat-1280.png)
- [Chat at 390 px](chat-390.png)

## Checker and gates

- PASS: Test-first refusal of a new whole-stream read, followed by parser, scope,
  exact-count and Git-base comparison tests. The first test failed before the
  script existed; the additional cases failed before baseline support was added.
- PARTIAL: A direct Node invocation failed before assertions because this test
  requires the Vitest runner.
- PASS: The rebased focused checker test then passed once, 22/22, in 32.08 seconds.
  Tests and CPU-heavy checks ran under `nice -n 10`.
- PASS: The repository scan recorded 312 known reads and 5 rebuild reads across
  exactly three files with reasons. Its final measured elapsed time was 2.66 seconds.
- PASS: The earlier branch run recorded dependency direction, offline links, fixture
  boundaries, package licences, CI grouping (52 tests) and shard sequencing (3 tests).
  The new file is selected by `scripts/*.test.mjs` and recorded in the shard timing registry.
- FAIL: `nice -n 10 npm run lint` stopped during repository-wide ESLint after
  Node reached its 4 GB heap limit. The new script and test passed changed-file
  ESLint. The remaining lint stages were not run by this command.
- PASS: Typecheck, event-catalogue agreement (174 types), changelog, Markdown,
  Knip and changed-file ESLint.
- NOT RUN: Full root suite, separate web tests, crapper, dryer and mutator.
  The three clean-code tools are not enabled in this repository.

## Cleanup

PASS: Stack 1 was stopped and released with `infra/dev-stack/down.sh` after both
screenshots were copied. Generated updates to unrelated evidence files were
restored. The one-minute load was checked before startup; it was below 10 when
the stack was claimed. The worktree is retained for review.

PASS: Stack status reported `free` after teardown. Public-privacy and secret scans
are run after the final evidence edits and before the push.
