# Computer and web session configuration

Journey on a fresh dev stack: PASS

On 16 November 2026, secondary slot 1 ran `infra/dev-stack/up.sh --fresh` at
head `5eb6df9e1bcddfb8b386063ccf01421def7600ae`. Managed stand-in calls were enabled.
The pinned computer image was
`sha256:ca3c13f72783b68a48aaaae7e8c469393dc2618221b6dd8e91e56397365f59e0`,
built from source commit `f32d646294fd60cac5504bdaa2a29fb90169d182`.
The intervening commits change its README diagram and pin that image.
Later documentation and receipt commits do not claim another journey run.

Startup, CORE, status and teardown all returned 0. Status after teardown says
`free`. [Retained CORE result lines](core-results.txt) and
[stack results](stack-results.txt) record the observed checks and release.
Private identity and screenshot directory values were replaced with placeholders.

## Browser steps and observed results

1. Started the fresh secondary stack and signed in through Zitadel with separate
   owner and member browser contexts. Used the installed Playwright runner at
   390 px and 1280 px against the selected slot's origin.
2. Opened a personal chat, sent a message and saw the streamed reply finish.
   Reload kept exactly one reply. Sent another message, pressed Stop and saw the
   partial reply survive reload at both widths.
3. Uploaded a PDF and waited for Ready. Saw the reply use its expected contents.
   Opened PDF, text and image previews. Reload kept one file per upload. EICAR,
   unsupported type and oversized upload refusals passed at both widths.
4. Tried the computer viewer without a grant and saw refusal. Granted access,
   opened the real desktop, then revoked access. Pixels cleared and Stop was
   recorded at both widths.
5. Used the owner's controls to save paying-group and assistant spending ceilings.
   Over-ceiling calls were refused, and the refusal remained after reload at both
   widths. The journey restored the earlier ceilings.
6. Checked private history, organisation access, expired sessions, logout CSRF,
   sign-out and reauthentication. Observed the expected refusals. Member and tool
   catalogue replay verification also passed.

Both saved chat screenshots were visually checked. The reply, retained partial
reply after Stop and composer fit the 390 px viewport; the 1280 px chat retains
its session panel and navigation.

[1280 px chat](chat-1280.png) · [390 px chat](chat-390.png)

[1280 px spending refusal](spending-refused-1280.png) ·
[390 px spending refusal](spending-refused-390.png)

CORE explicitly skips its approval journey; approval is NOT RUN. Paid-provider,
live personal-memory, routine execution and a separate live subchat tool-refusal
journey were NOT RUN. This clean-up changes none of their permissions.
The existing gateway/computer tests cover shared-child tool and memory refusals.

## Own checks

- PASS: test-first commit `e891da3fa` failed because the computer configuration
  reader did not exist. `2b1862424` failed because the browser reply contract
  rejected the configuration view. The implementation then passed both.
- PASS: `3b36db97a` first reproduced an extraction defect: a frame with both
  routine and shared identifiers accepted personal initial input. The final
  mapping preserves the original refusal. No existing assertion was changed.
- PASS: changed computer/server cases twice, within the final 205-case run
  (71.67 seconds) and a 50-case repeat (59.26 seconds). The selected 205 cases
  include session creation, subchat review, chat HTTP, private input, Stop,
  attachments, recall and the configuration table. Earlier security checks also
  passed; both API field names pass the existing risky-field-name expression.
- PASS: all 1,591 web tests, including the two new cases, and those two cases again;
  production web build. Existing Mermaid and CommonJS build warnings remain.
- PASS: 212 selected computer tests including native Codex fixtures, plus seven
  configuration tests against the exact production image used by the journey.
- PASS: full workspace and infrastructure typecheck, then final computer and
  server typechecks; event catalogue agreement for 174 types; Knip; changelog;
  scoped ESLint with zero warnings; Markdown; dependency, README, size-debt and
  whole-stream-read checks. Knip retains its two existing configuration hints.
- PASS: existing test lines and assertions are unchanged. Tests, lint, typecheck
  and builds ran under `nice -n 10`; database tests used the shared disposable
  PostgreSQL database. No full root suite or full root lint ran.

## Cleanup

Shared the computer's settings through the existing event-library configuration.
Sent the browser only its default-mode view through the protocol library. Finished
moving the two remaining payer comparisons and assistant readers in session
creation and subchat request review. Split granted-input construction into the
existing input module and session-creation reading out of the full route module.
New functions have at most four parameters and fewer than 80 counted lines.
No size limit or suppression was raised. The computer diagram has eight boxes.

Shipped code and runtime manifests: 155 added plus 85 deleted lines, 240 total.
Tests, documents and receipts are excluded. The creator-only checks and their
subchat disagreement remain exactly as before; the owner question stays open.
