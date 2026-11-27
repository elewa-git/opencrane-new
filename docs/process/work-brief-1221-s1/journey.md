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

The local computer image was rebuilt for the notice review. Its contents check
passed. A fresh Syft scan and notice collection reproduced
`unassigned-notices@1`: 394 of 395 entries passed before the assignments.
The same command and evidence passed after the assignments: 394 of 394 entries.
The extra failing entry disappears when every notice has an owner; no package
was removed. The independent notice check found all 104 installed notice files.
The licence policy tests passed twice. They reject changed prompt notices and an
additional unassigned notice. The checker and its rules were not changed.
Raw output remains outside the repository in `image-before.log`,
`image-after.log`, `build.log`, `sbom.json` and `notices.json`.

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

## Package hash and CI test placement repair

Journey: NOT RUN, as instructed. No secondary stack was claimed.

The native inventory recorded the licence review hash from before the retained
Codex notices were assigned. The review still contains those intended assignments.
The inventory now records its actual SHA-256. A new source test failed for that
exact mismatch before the fix and passed twice afterwards. It checks all three
review input hashes without requiring an image build. All 14 native helper,
template and notice source hashes also pass.

The assistant native test was missing from the computer image job's file list.
The CI selection test failed for that missing file before the fix and passed
twice afterwards. The file now runs in the image job and is excluded from all four
ordinary shards. The test assertions and time limits are unchanged.

The first local native test attempt failed while waiting for the default fixture
image to become healthy. The test passed twice with the rebuilt round 2 computer image.
This check uses a local stand-in model and costs 0 euro cents.

Application package run 45980193385 was dispatched after the hash repair was
pushed. Its result belongs to CI; the PR records its current status.
