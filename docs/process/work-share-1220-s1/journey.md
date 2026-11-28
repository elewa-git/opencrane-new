# Assistant file sharing journey

Journey on a fresh dev stack: PASS

A member used the running product at **1280 px and 390 px**. Aster's three-slide
PDF appeared as a file card, rendered in preview and downloaded. Share beside an
unshared note produced a scanned notes file with preview and download. Sharing an
antivirus test file produced a visible refusal and no file card.
Paid model spend: **0 euro cents**. Slot 1 was released and reports `free`.

## Installation and source

Final journey source: `3de77755d7bc642d5706aac6dc033016aecd39ba`.
The fresh Compose installation started at `6321ba0d19f28cf96028c5d66b062db42ada5ba0`.
Later changes only corrected the browser driver and its documentation; application,
computer and model stand-in source stayed the same on this installation.

Both startup attempts had a complete five-minute load window below 6, sampled every
30 seconds, with slot 1 free. The final quiet window lasted 324 seconds. The protected
pilot in slot 2 was excluded and untouched. Every stack command selected id 1.
No fleet guard was removed or bypassed. This was a development installation, not a
packaged or paid-provider check.

The second fresh startup and status check passed. Startup logged 37 PASS lines,
including browser checks and replay verification. Its separate long-chat approval
journey was skipped by the standard runner; this receipt does not claim that check.
The browser used the existing reviewed computer image and the free stand-in model.
Main already supplies the approved persona and instructions to save and link finished
files. This change adds the missing Share action through the normal message route.
No computer prompt, runtime image or file access rule changed.

## Browser steps

| Step | 1280 px | 390 px |
| --- | --- | --- |
| Use approved persona Aster | PASS | PASS |
| Ask “make a short slide deck introducing yourself” | PASS | PASS |
| See `Meet_Aster.pdf` as a file card | PASS | PASS |
| Render the slides in preview and download the PDF | PASS | PASS |
| Reload and retain the deck card | PASS | PASS |
| See Share beside the unshared notes | PASS | PASS |
| Keep Share disabled while an unfinished draft is present | PASS | PASS |
| Clear the draft and use Share with Enter | PASS | PASS |
| Open and download the scanned `Aster_notes.txt` | PASS | PASS |
| Share the antivirus test file, open its failed Activity detail and see the refusal | PASS | PASS |
| Keep the refused file out of the file cards | PASS | PASS |
| Keep the page and transcript within the viewport | PASS | PASS |

The first browser run saved four survey answers, edited the proposed persona to
name Aster and approved revision 2 through the page. Later runs checked that same
approved persona before opening new conversations. The final run completed both
widths from beginning to end on the same fresh installation.

Each downloaded deck was **1,306 bytes** and contained three pages naming Aster.
Each notes download was **30 bytes**. The Share control measured at least 44 × 44 px.
The final screenshots were inspected, including rendered slides and the visible
malware refusal. The free model makes real files through the computer's shell and
requires the approved Aster instruction in its model request. These checks cover
file creation, sharing, scanning and the browser; they do not qualify a real model's
writing or judgement.

## Pictures and results

| Observation | Desktop | Phone |
| --- | --- | --- |
| Deck card | [PNG](shared-deck-1280.png) | [PNG](shared-deck-390.png) |
| Rendered PDF | [PNG](deck-preview-1280.png) | [PNG](deck-preview-390.png) |
| Unshared note and Share | [PNG](not-shared-1280.png) | [PNG](not-shared-390.png) |
| Shared notes card | [PNG](shared-notes-1280.png) | [PNG](shared-notes-390.png) |
| Notes preview | [PNG](notes-preview-1280.png) | [PNG](notes-preview-390.png) |
| Scanner refusal | [PNG](scan-refusal-1280.png) | [PNG](scan-refusal-390.png) |

[Approved persona](approved-persona-1280.png) · [Browser results](results.json) ·
[Source checks](checks.json).

## Own source checks

- **PASS:** corrected failing tests before implementation. Main's template loaded the
  unshared note, then failed all four cases because Share was absent. The free model
  also failed to issue a file-creation call before its example was added.
- **PASS:** 48 focused web tests twice; all 1,695 web unit tests in 93 files with two workers.
- **PASS:** ten stand-in tests twice after the provider-probe fix, including a real
  three-page PDF and the existing link, wake and provider cases. The text-input probe
  was seen failing before that fix.
- **PASS:** four existing server file-publication tests, using disposable services and
  the shared test database.
- **PASS:** all workspace, package and development-stack typechecks. The development
  stack was checked again after the driver corrections. Browser application source
  did not change after its full tests and production build.
- **PASS:** event catalogue, 175 types; Knip with two existing configuration hints;
  changed-file ESLint without warnings; changelog and Markdown checks.
- **PASS:** production web build. Unchanged styles and bundled dependencies produced
  existing build warnings. No limit was raised.

All tests, typechecks, lint and builds ran under `nice -n 10`. No full root test suite
ran. No dependency, event or server route was added. The local ESLint configuration
also included the changed infrastructure files and checked the new files' size and
complexity; the repository's normal configuration excludes infrastructure.

## Earlier attempts and corrections

**First startup — FAIL.** Owner setup passed, then the provider check was refused.
The edited stand-in required message arrays, while the existing probe sends text
with streaming off. A failing HTTP regression reproduced this before the fix.
The stand-in now accepts both forms. The startup log and 14 application service
logs were sanitised and retained before teardown; none was withheld. Compose logs
were not retained for that attempt. Teardown returned 0 and slot 1 reported free.

**First browser run — PARTIAL.** The phone deck and notes downloads worked. The
scanner refused the antivirus test file, but the driver waited for text inside a
collapsed Activity detail. The driver ended with exit 143 after that assertion
failure; the signal sender is unknown. Its early PDF screenshot was also blank,
so it was not accepted as proof of rendering. The corrected driver opens the failed
Activity detail and uses headed Chromium with its PDF load check before capture.

**Second browser run — PARTIAL.** The full desktop flow passed. The phone driver
then expected a hidden navigation status to be visible. The correction waits for
that loaded state to exist in the page, while keeping the navigation hidden on phones.
The final run returned 0 with both complete PASS results. These were browser-driver
corrections; no application fix or longer timeout was used.

## Make it right

Ordinary sends and Share use the same helper to send a draft and the session's
existing send check. One template shows the unshared note for both file links and
image syntax. The workspace's duplicate close check was removed because the session
already checks the saved close. Browser steps and free-model examples have small,
named functions. The edited stand-in checks request shapes before use.
No access, scan, spending or size rule was weakened.

## Evidence retention and release

Before final teardown, 16 application logs, eight container logs and three computer
pod logs were collected outside the repository. The repository's sanitiser withheld
one OpenFGA log because it contained a structured secret field; its contents are
not retained. Startup and earlier browser-failure logs were saved too. All 13 slice
screenshots were already outside the slot in this receipt folder before teardown.
The standard journey's screenshots were retained privately, and its unrelated
tracked pictures were restored in the worktree.

`down.sh --id 1` returned **0**. The final `status.sh --id 1` returned **free**.
The owner stack and protected pilot were not used.

Raw files remain only in the private task receipt folder. They include
`startup-safe.log`, `final-startup.log`, `browser-1-safe.log`, `browser-2.log`,
`browser-3.log`, `final-down.log`, `load-wait.jsonl`, `load-wait-2.jsonl` and the source
check logs. Downloaded files and diagnostic pictures also remain there. No raw log,
large capture, password, token or private host path is committed.
