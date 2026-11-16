# Gateway session configuration journey

Journey on a fresh dev stack: PASS for the observed CORE steps; approval: NOT RUN

On 16 November 2026, claimed secondary slot 1 ran `infra/dev-stack/up.sh --fresh`
against tested head `2eb779c0a990ff8b6969a9c1b6a839c69c5c14a5`.
Managed calls were switched on against the stand-in provider. Startup and CORE
returned exit code 0. `infra/dev-stack/status.sh` returned 0 with every checked
endpoint healthy. `infra/dev-stack/down.sh` returned 0 and released the slot.
A subsequent status check reported `free`.

Later commits change tests, documents and screenshots only. No later head is
claimed as executed. The shipped source, dependencies and runner remain those of
the tested head, so this CORE result still qualifies the review fix.

[CORE results](core-results.txt) retain the runner's results, including its expected
upload transport failures, built-in upload retries and explicit approval skip.
No timeout, retry or guard was changed. Only the developer account label and private
screenshot directory were replaced with placeholders.
[Stack results](stack-results.txt) record health, teardown and release.

## Browser steps and observed results

1. Signed in through Zitadel at the slot's origin in separate owner and member
   Playwright contexts, using the installed browser runner at 390 px and 1280 px.
2. Started a personal chat, sent a message and saw its streamed reply complete.
   Reload retained one reply. Sent another message, pressed Stop and confirmed the
   partial reply survived reload at both widths.
3. Uploaded a PDF, waited for Ready and saw its expected contents used in a reply.
   Previewed PDF, text and image files. Reload kept one file per upload. EICAR,
   unsupported type and oversized upload refusals passed at both widths.
4. Tried the computer viewer without a grant and saw refusal. Granted access,
   opened the real desktop, then revoked access. Pixels cleared and Stop was saved
   at both widths.
5. Used the owner's spending controls for paying-group and assistant ceilings.
   Over-ceiling calls were refused and the refusal remained after reload at both widths.
6. Checked private history, organisation access, expired sessions, logout CSRF,
   sign-out and reauthentication. The expected refusals passed. Member and tool
   catalogue replay verification also passed.

The signed-claim mismatch is not a browser control. The gateway acceptance test
covers that refusal through the recording gateway with real service fixtures.
The browser journey covers the person's normal chat and visible spending refusals.
The existing approval journey is explicitly skipped by CORE and remains NOT RUN.
Paid providers and live personal memory qualification were NOT RUN.

[1280 px chat screenshot](chat-1280.png) · [390 px chat screenshot](chat-390.png)

## Own checks

- PASS: failing test commit `c37d1aa08` first observed the new signed-class case fail
  with private rather than shared configuration. The implementation then passed it.
- PASS: 262 regression tests in 13 selected files, including gateway costs, access
  races, refusals, grants, managed calls, shared assistants, shared child passes,
  memory rights and pass signing. This preceded reuse of the identical existing
  identifier schema. No existing assertion was edited.
- PASS: the final 37 configuration, token, claim-binding and memory-rights cases
  twice after cleanup: 17.01 seconds and 17.90 seconds.
- PASS: removing the saved sharing-class comparison made both new gateway refusal
  cases fail with HTTP 200 instead of 403. Restored the guard before final runs.
- PASS: removing the memory execution guard made all three new mode-refusal cases
  fail because access was granted. Restored the guard before final runs.
- PASS: full workspace and infrastructure typecheck; models typecheck after final
  cleanup; event catalogue agreement for 174 types; Knip; changelog; scoped ESLint
  with zero warnings; Markdown; README, size-debt and whole-stream-read checks.
  Tests, typecheck and lint ran under `nice -n 10`; database tests used the shared
  disposable test database. No full root suite ran. Web and computer code is unchanged.
- PASS: public privacy and complete commit-range secret checks before push.
- NOT RUN: hosted CI for the review fix. The orchestrator owns the second review pass.

## Cleanup

The gateway and turn issuer share session configuration. Both tool routes now use
one subchat refusal, and shared assistant payer matching reads the configuration.
Memory still requires an explicitly saved restricted mode. The gateway ignores a
supplied configuration and checks signed claims against saved starts first.

Split identity and session access handling into `decision-context.ts`, with at most
four parameters and fewer than 80 counted lines per new function. Reused the
identifier schema, digest and bounded authority reader. Removed the extra assistant
history read, lowered its read baseline and parameter suppression, and removed
`decision.ts`'s file-size exception. `startDecision` stays at 299 physical lines,
its original length. The existing creator check and subchat exemption are unchanged.
No further conflicting pair was found. The open creator-only question remains on
issue #1106; no ownership decision was made here.

Shipped code: 162 added plus 86 deleted lines, 248 in total, including the two
smaller script baselines. Tests, documents and these receipts are excluded.

## Tool refusal test evidence

The first review found that the old shared-child tool requests could be refused
for malformed MCP metadata and an unknown memory tool before proving either
shared-class guard. PASS: the original test still passed with the ordinary MCP
route's shared-class check bypassed, reproducing the missing protection.

Test commit `a22169c63` adds otherwise-valid `read` and `remember` requests to the
HTTP authorisation routes. Both include protocolVersion and clientCapabilities
metadata. Each test first obtains and dispatches a private-turn permit to the
recording tool backend. The memory control signs and verifies a real memory pass.
These controls qualify gateway authorisation, not live personal memory writes.

PASS: bypassing only the ordinary MCP route's shared-class check made its new
test fail with HTTP 200 instead of 403 and a non-null permit for both initial and
renewed turn passes. The memory case passed with its check still in place.
PASS: restoring MCP and bypassing only memory made the memory case fail in the
same way, while the ordinary MCP case passed. Both checks were restored.

The refusal cases assert no permit, no memory context header or signing, no new
backend call and an unchanged budget state, including reservations, settlements
and dispatches. No existing assertion, shipped code, ownership rule, timeout or
retry was changed. The existing 1,500-event history-loading limitation is outside
this test fix. No new dev stack was needed or claimed.

Own review-fix gates: PASS for all three changed-file tests twice (22.82 seconds
and 23.51 seconds), event catalogue agreement for 174 types, Knip, changelog and
scoped ESLint with zero warnings, full workspace and infrastructure typecheck,
Markdown, public privacy and staged secret scanning. Tests, typecheck and lint ran
under `nice -n 10`; database fixtures used the shared disposable PostgreSQL database.
