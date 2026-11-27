# Assistant identity and tools

Journey on a fresh dev stack: NOT RUN

The real-model package journey is refused by `requireFleetStandInProvider` in
`infra/dev-stack/journey-guard.ts`. Calling that check for provider mode returns
"Fleet tasks require the stand-in model" because the inherited fleet marker is
present. The marker was kept, as required. No slot was claimed, no installation or
browser step started, and no screenshots were taken. The pilot was untouched.
Raw refusal output is retained as `live-guard.log` outside the repository.

## Planned browser steps

1. Install the approved package on a fresh slot 1.
2. Sign in as a new member and finish onboarding. Approve a persona with an
   assistant name, voice and values.
3. Ask the assistant to introduce itself and describe what it can do here.
4. Ask for a short slide deck introducing itself. Check the shared file card,
   preview and download at desktop and phone widths, 1280 and 390 pixels.
5. Ask for a page that needs network access. Check the assistant explains the
   missing access and offers an alternative without claiming a successful fetch.
6. Save safe screenshots and spending in integer euro cents, then release the slot.

## Local evidence

- PASS: the first test commit fails on missing persona content, the Codex identity
  and the absent replacement instruction file. The implementation passes those tests.
- PASS: the approved onboarding reader keeps identity with the member's personal
  assistant, ignores unapproved drafts and refuses a removed member.
- PASS: personal, shared and routine configurations contain the replacement soul
  and the correct developer instructions. Restricted turns retain their tool limits.
- PASS: pinned Codex, a disposable computer and a stand-in model complete a real
  shell call. Changing the approved persona replaces the soul in the same chat.
- PASS: the real gateway money fixture records two dispatches and two one-cent
  settlements after an identical ordinary chat request is replayed. Both retry
  limits remain zero to avoid a second charge.
- PASS: temporarily removing the persona's owner check makes its access test fail.
  Setting request retries to one makes the spending-safety configuration test fail.
  Both mutations were restored before the final checks.
- Private CODEX_HOME: NOT REPRODUCED. The existing supervisor creates the
  `codex`, `tmp` and `work` folders before launch. Native private configuration
  and lifecycle fixtures pass. This is fixture evidence, not live qualification.

Paid model spending for this work: 0 euro cents. Stand-in calls cost 0.
The one-cent settlements above are synthetic fixture prices.

## Source checks

| Check | Result |
| --- | --- |
| Changed tests | PASS twice: 40 cases across 8 files |
| Text schema and event security fixtures | PASS: 303 cases |
| Full typecheck, including package and dev stack | PASS |
| Event catalogue | PASS: 175 types agree |
| Knip | PASS; two existing configuration hints |
| ESLint on changed code | PASS; no warnings |
| Markdown and changelog | PASS |
| Dependencies, lint debt, READMEs and whole-stream reads | PASS |
| Public privacy and secret scan | PASS |

No web source changed. No independent review was run by this builder.
