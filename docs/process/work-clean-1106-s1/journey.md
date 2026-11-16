# Server session configuration journey

Journey on a fresh dev stack: PASS

On 16 November 2026, secondary slot 1 ran `infra/dev-stack/up.sh --fresh`
against implementation commit `382a79cfe`. The first claim found both slots busy;
the next claim succeeded after the required wait. Managed calls were switched on
against the stand-in provider. Startup and the CORE journey returned exit code 0.
`infra/dev-stack/status.sh` then returned 0 with all checked endpoints healthy.
`infra/dev-stack/down.sh` completed with exit code 0 and released the slot.

## Browser steps and observed results

1. Signed in as the owner and member through Zitadel at the selected stack origin,
   using separate Playwright contexts at 390 px and 1280 px.
2. Opened a new personal chat, sent a message and saw a streamed reply finish.
   Reload kept one completed reply. Sent a second message and pressed Stop;
   the partial reply remained after reload at both widths.
3. Attached a PDF, waited for Ready, asked about its contents and saw the expected
   file text used in the reply. Opened previews and the original download, then
   reloaded without duplicate files. Text and image previews also passed.
4. Selected the EICAR test file and saw the malware refusal. Selected an unsupported
   executable and an oversized file and saw their refusals. Refused files were absent
   from the saved file list. These checks passed at both widths.
5. Tried the desktop without a grant and saw refusal. Granted access, opened the
   real desktop, then revoked access; pixels cleared and Stop was recorded at both widths.
6. Used the owner’s spending controls for paying-group and assistant ceilings.
   Over-ceiling calls were refused, and the refusal remained after reload at both widths.
7. Checked private history, organisation access, expired sessions, hostile logout
   requests and sign-out. The CORE runner reported their expected refusals and success.
8. Ran the required stack status check, then called `infra/dev-stack/down.sh`.
   Teardown completed with exit code 0; the secondary slot was released.

## Screenshots

- [Desktop chat, 1280 × 900](chat-1280.png).
- [Phone chat, 390 × 844](chat-390.png).

Both are the original screenshots from this fresh attempt. They were visually
checked for email addresses, credentials and private paths before saving here.

## Conditions not run live

The CORE runner explicitly skipped its approval journey. Private-memory qualification,
routine execution and the disputed shared-subchat ownership rule were NOT RUN live.
The configuration table and existing server tests cover their saved configurations;
this receipt claims only the observed CORE journey. No gateway, turn-pass, computer
or website configuration consumer was changed.

## Own source checks

- PASS: the table test failed before the new module existed, in commit `8385d5c7a`.
- PASS: the configuration table has 11 passing cases and passed twice after implementation.
- PASS: reversing the shared assistant payer comparison made five table cases fail.
  The comparison was restored before the final checks.
- PASS: the focused server batch passed 95 tests in 131.66 seconds.
- PASS: the broader event and server batch passed 664 tests in 264.61 seconds.
- PASS: the affected shared-assistant suite passed all 46 tests after retaining
  the event schema's original field order. No existing test assertions changed.
- PASS: changed-file ESLint, Knip, event catalogue, changelog, Markdown, README,
  whole-stream-read, lint-debt and dependency checks.
- PASS: full workspace, package and dev-stack typecheck.

The first upload test attempt failed because the existing disposable computer
image lacked a module required by current source. A separate fixture image was
built from the current Dockerfile; the final upload tests passed against it.
No computer source or Docker configuration was changed.

## Scope held for the owner

The creator-only checks in `apps/server/src/chat/private-session.ts`
(`writePrivateSession`, `requirePrivateReader` and the cached reader) remain
unchanged. The corresponding condition in `apps/server/src/chat/turns.ts`
(`sessionPayer`) still exempts `contextKind: shared_child`.
The configuration has no audience field. The
[open owner question](https://github.com/elewa-git/opencrane-new/issues/1106#issuecomment-6923596900)
records the difference. Gateway, turn-pass, computer and website changes remain
outside this slice.

## Make it right

Shared the session configuration and assistant reader instead of retaining their
replaced checks and local schemas. Split thread ownership and process reuse checks
into `turn-threads.ts`. Retained existing parser validation and saved event field
order. Added no dependency, event type or API field and raised no size limit.
The shipped-code change is 243 added plus 79 deleted lines: 322 in total.

## Short work log

1. Checked current main and pull requests; no earlier PR or merge covered this slice.
2. Read the ticket and pinned every current session kind before implementation.
3. Replaced equivalent server decisions and retained the disputed ownership checks.
4. Fixed the extraction's event-order defect using the existing failing creation tests.
5. Ran the source gates before attempting fresh live qualification.
