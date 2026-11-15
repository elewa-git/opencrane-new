# Fresh core journey and checker evidence

Date: 15 November 2026  
Source head: `04bf6fe17ebd95048bc9a8e082d118c765a40eb8`  
Stack: fresh secondary stack 1, claimed with `infra/dev-stack/claim.sh` and started
with `infra/dev-stack/up.sh --fresh` using the local model stub.

Startup began at `807de07f920eb6135bc31ce7d002ad1f37f0f95f`. Only checker helpers
and review instructions changed during the run. The product source stayed identical
throughout; the final diff against origin/main contains zero changed lines under
`apps/` and `libs/`.

## Journey

Journey on a fresh dev stack: PASS (core journey; no product change).

- PASS: Existing members and assistants retained model grant history, including revocations.
- PASS: Owner and member signed in through Zitadel and PKCE at 390 px; member sign-in
  also passed at 1280 px in a separate browser context.
- PASS: Hostile and missing logout origins were refused without losing the real
  session. A wrong-organisation token and an expired session were refused.
- PASS: Member join reached PostgreSQL, OpenFGA and the live WebSocket. New member
  and assistant model grants reached OpenFGA before chat.
- PASS: Browser chat at 390 px and 1280 px streamed a stub reply, reloaded without
  duplicates and retained partial text after Stop and reload.
- PASS: Uploads at both widths passed scanning, bounded turn context, previews and
  reload without duplicate files. EICAR, type and size refusals passed. The runner
  reported one upload retry and zero preview retries at each width.
- PASS: Live view at both widths refused access without a grant. A grant enabled
  the real desktop and stub turn; revocation cleared pixels and audited Stop.
  Revocation took 414 ms at 390 px and 188 ms at 1280 px.
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
- PASS: Final focused checker tests passed twice, 22/22 each, in 22.70 and
  27.30 seconds after the helper split. Tests and gates ran under `nice -n 10`.
- PASS: The repository scan recorded 312 known reads and 5 rebuild reads across
  exactly three files with reasons. Its final measured elapsed time was 2.66 seconds.
- PASS: Typecheck, event-catalogue agreement (174 types), changelog, Markdown,
  changed-file ESLint, dependency direction, Knip, offline links, fixture boundaries
  and package licence checks.
- PASS: CI grouping checks, 52 tests; shard sequencer checks, 3 tests. The new file
  is selected by `scripts/*.test.mjs` and recorded in the shard timing registry.
- FAIL: `npm run lint`, with ESLint temporarily scoped to the two changed code
  files to follow the local lint-scope rule. Its original package script was
  restored afterwards. The README check refuses three existing entries:
  `infra/clamav/README.md` has 154 lines with no record;
  `infra/dev-stack/README.md` has 218 against 213 recorded;
  `infra/package/README.md` has 341 against 335 recorded. These files and their
  baseline are unchanged from origin/main. Later lint stages passed separately.
- NOT RUN: Full root suite, separate web tests, crapper, dryer and mutator.
  The three clean-code tools are not enabled in this repository.

## Cleanup

PASS: Stack 1 was stopped and released with `infra/dev-stack/down.sh` after both
screenshots were copied. The runner's updates to older evidence files were restored.
The one-minute host load was checked before startup and teardown; queued final
checks waited while it exceeded 10. The worktree is retained for review.

PASS: Final public-privacy and secret scans were clean. Stack status reported `free`.
