# Assistant identity and tools

Journey on a fresh dev stack: NOT RUN

The orchestrator will run the packaged journey on the demo install. This repair
claimed no secondary stack and made no changes to the pilot. No browser steps or
screenshots were taken. The earlier provider attempt was refused by
`requireFleetStandInProvider`; its raw output remains in `live-guard.log` outside
the repository.

## Planned browser steps

1. Install the approved package on a fresh secondary stack chosen by the orchestrator.
2. Sign in as a new member and finish onboarding. Approve a persona with an
   assistant name, voice and values.
3. Ask the assistant to introduce itself and describe what it can do here.
4. Ask for a short slide deck introducing itself. Check the shared file card,
   preview and download at desktop and phone widths, 1280 and 390 pixels.
5. Ask for a page that needs network access. Check the assistant explains the
   missing access and offers an alternative without claiming a successful fetch.
6. Save safe screenshots and spending in integer euro cents, then release the stack.

## Local evidence

- PASS: 52 cases across nine focused test files, twice after the final code changes.
  These cover persona approval, delivery, parsing, session instructions, thread
  reload, routine preparation, native shell use and chat replay cost.
- PASS: a team assistant with the same owner receives no personal persona.
  Membership is checked without approval and again after the persona point read.
  Removing the member during that read refuses before decryption.
- PASS: a qualified personal restricted turn receives no onboarding persona.
  Invalid assistant kinds are refused even without a persona.
- PASS: removing each of the five protected checks separately makes its regression
  test fail for an assertion. Each change was restored before final checks.
- PASS: shared and routine turns reject personas through the restricted-mode rule.
  Their earlier mode checks make the two removed context clauses redundant.
- PASS: the existing reload and preparation assertions still pass. ESLint's own
  counting rule reports `threadLoads` at 283 lines and `routineThreads` at 84,
  matching their sizes on the main branch before this feature.
- PASS: the rebuilt computer passes `contents.py`, including exact source bytes,
  prompt permissions and the absence of runtime credentials and build files.
  The first attempt used an older fixture image whose event package did not export
  `memory-text`; the rebuilt image fixed that mismatch.
- PASS: the application source checks cover all five native helpers, seven templates
  and the Codex licence and notice. Missing reviewed instruction files failed before the fix.
  The image allowlist and SHA-256 comparisons remain exact.
- PASS: the real packaged bootstrap entry point finishes owner setup with synthetic
  services. The fixture now supplies the event-store clock required by ownership
  setup. It failed with the missing clock before this repair.
- PASS: the real gateway fixture records two dispatches and two one-cent settlements
  for an identical ordinary chat replay. Both retry limits remain zero. The owner
  moved safe retries to the next slice, which needs repeated-request recognition
  in the gateway before it can prevent a second charge.

Private CODEX_HOME: NOT REPRODUCED. The supervisor creates its private folders
before launch. Native fixture checks pass; this is not live qualification.

Paid model spending for this work: 0 euro cents. Stand-in calls cost 0.
The one-cent settlements above are synthetic fixture prices.

## Source checks

| Check | Result |
| --- | --- |
| Changed tests | PASS twice: 52 cases across nine files |
| Five guard-removal checks | PASS: each regression fails for its own missing check |
| Computer image contents | PASS |
| Native helper and template source hashes | PASS |
| Synthetic packaged owner bootstrap | PASS |
| Full typecheck, including package and dev stack | PASS |
| Event catalogue | PASS: 175 types agree |
| Knip | PASS; two existing configuration hints |
| ESLint on changed app code | PASS; no warnings |
| Package fixture JavaScript lint and syntax | PASS |
| Markdown and changelog | PASS |
| Lint debt and whole-stream reads | PASS |
| Public privacy and secret scan | PASS before pushing |
| Final application image approval | NOT RUN locally; the pull request records CI |

The full local image check of the first build was stopped after product source
changed. Final image approval remains a separate check of the final pushed commit.
Raw command output stays outside the repository. No live condition is marked PASS.
