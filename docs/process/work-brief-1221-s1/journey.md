# #1221 packaged journey receipt

## Run 4 — PASS

**Date:** 28 November 2026. **Environment:** fresh packaged slot-1 install,
real provider, operator run without `OPENCRANE_FLEET_TASK`.
**Tested source:** `b23192dad1cf71bd64cb62fe12906407fd832390`.

Rebased onto `origin/main` at `d6928cd30` before installation. This includes
PR #1226's repair for history reads after a shared file. The rebase changed no
computer source, image pin or recorded checksum. The installed-image source check
and package licence/checksum check both passed, so no computer rebuild was needed.
Pushed the rebased head and waited for both exact-head approvals:
[application 46101000479](https://github.com/elewa-git/opencrane-new/actions/runs/46101000479)
and [scanner 46101002974](https://github.com/elewa-git/opencrane-new/actions/runs/46101002974).
Both passed. All four approval/image artifacts were present and unexpired before
package preparation, with expiry on 29 November.

### Fresh installation

- **PASS:** slot 1 was free and the one-minute load stayed below 6 for five minutes,
  sampled every 30 seconds. Earlier load spikes restarted that timer. The live pilot
  was excluded from the wait as instructed. Claimed slot 1 explicitly.
- **PASS:** package preparation, private secret preparation, fresh package installation
  and package check. Every secondary stack command selected id 1. Used the documented
  `OPENCRANE_ACCEPT_DEV_HOST_RISK=accepted-dev-box-366` exception for this host's swap
  and crash-report settings. No host setting was changed.
- **PASS:** before the first personal-chat prompt, both running computer pods used
  `sha256:c9c92d8376363be6c1de511d499b4ff0007c24a73d0c551345049635fcd5a132`,
  matching the tested head's pin. Their reported image IDs matched and
  `/app/src/assistant-brief.ts` existed in both.
- **PASS:** the `computer-runtime` gateway pointed to the cluster model service,
  rather than `http://127.0.0.1:1`. No run interruption or gateway 502 occurred.

### Browser steps and observations

| Step | Result | Observation |
| --- | --- | --- |
| Invite and onboard a member | PASS | Saved all four survey answers, approved persona revision 2 naming Aster, and completed the welcome. |
| Personal chat, Memory off | PASS | Opened at 1280 and 390 px. All five requests omitted an execution-mode override; saved starts also omitted it. This fresh install had no Memory qualification, so personal turns used the Memory-off default. No restricted turn was observed. |
| Introduce yourself | PASS | “Hi Sam, I’m Aster, your personal assistant.” The reply did not identify itself as Codex. |
| What can you do here? | PARTIAL alone | Plainly said it cannot reach the internet from its computer yet, and that web pages, downloads and online installs fail. Listed downloadable files, but omitted local software installs and browser control. |
| Explicit capability follow-up | PASS | Confirmed chat file sharing, allowed sandbox software installs subject to package availability, unavailable internet and no browser-control tool. The initial omissions were checked with a further question, without changing product code. |
| Make a short slide deck introducing yourself | PASS | Shared `Meet_Aster.pptx` as a visible chat file card. The downloaded file was 33,803 bytes and contained four slides naming Aster. |
| Reload after sharing the deck | PASS | The same file card remained visible after two full reloads, at both widths. The history API returned HTTP 200 after file publication. |
| Fetch example.com | PASS | A command failed because a program was absent, then a network attempt failed with name resolution unavailable. The browser reply plainly said it could not inspect the page and offered pasted or uploaded content instead. It claimed no successful fetch. |

The explicit follow-up was: “Can you share files to this chat, install software,
access the internet, or control a browser? Please explain the limits plainly.”
It completed the capability check; the unprompted answer's omissions remain recorded
above. No source changes or rework round were part of this journey.

The private journey script needed navigation corrections: it first waited for
persona approval on the survey page, then waited on the old welcome page state,
then looked for a button where the completed welcome offers a link. Continued from
saved survey and welcome state after checking it in the browser. No saved answer,
provider test or chat prompt was resubmitted. These were journey-script corrections;
no application change was made. Sanitised service logs were retained before teardown.

### Screenshots and small result

| Observation | Desktop, 1280 px | Phone, 390 px |
| --- | --- | --- |
| Welcome complete | [PNG](run4-welcome-complete-1280.png) | [PNG](run4-welcome-complete-390.png) |
| Personal chat | [PNG](run4-chat-1280.png) | [PNG](run4-chat-390.png) |
| Aster introduction | [PNG](run4-intro-1280.png) | [PNG](run4-intro-390.png) |
| Initial capabilities | [PNG](run4-capabilities-1280.png) | [PNG](run4-capabilities-390.png) |
| Explicit capability follow-up | [PNG](run4-capabilities-followup-1280.png) | [PNG](run4-capabilities-followup-390.png) |
| Deck card after reload | [PNG](run4-deck-reloaded-1280.png) | [PNG](run4-deck-reloaded-390.png) |
| Fetch refusal | [PNG](run4-fetch-1280.png) | [PNG](run4-fetch-390.png) |

[Approved persona](run4-persona-approved-1280.png) · [Small result](run4-result.json).
Raw service logs, browser diagnostics and the downloaded deck remain outside the
repository. Raw files include `package-up.log`, `server-package.log`,
`browser-result.json`, `welcome-wait-result.json`, `delivery-check.json` and
`spending-final.json`.

### Spending, checks and release

**PASS — spend:** **17 euro cents** settled across 15 reservations and 15
settlements, including provider setup and the five chat turns. Unknown settlements:
0. Outstanding holds: 0 cents. This is the new run's spend, separate from earlier
runs. With the operator's approximate starting spend of 20 cents, the daily total
was about 37 cents, within the 2,000-cent allowance.

**PASS — local checks:** full typecheck; event catalogue, 175 types; Knip, with two
existing configuration hints; changelog lint; Markdown lint; package licence and
source checksum check; installed computer source and permission check. No product
code changed in this run, so changed-file ESLint had no files to check. Public
privacy and secret scans passed before the rebase push and run again for the receipt.

**PASS — hosted CI:** [run 46101006732](https://github.com/elewa-git/opencrane-new/actions/runs/46101006732)
passed on the tested head: all four test shards, both fixture jobs, checks and
`ci-ok`. **PASS — release:** package-down and down completed; slot 1 reported free
and its package namespace was absent. The owner stack, port 44200 and
live pilot slot 2 were untouched. This run makes no claim about private Memory,
browser control or successful internet access.

## Round 8 — plain internet wording

**Date:** 28 November 2026. **Verdict: PARTIAL.** Source checks pass; a fresh
real-model and browser journey is NOT RUN.

The prompt now plainly says that the computer cannot reach the internet yet.
Web pages, downloads and online installs fail. The organisation's gateway will
decide access later. The assistant may still try a request and must explain a
refusal plainly and offer an alternative. No execution or access rule changed.

**PASS — failing test first.** Commit `5af828cd4` records the changed template
expectations. Both personal and shared cases failed on the old wording. The native
check also failed on the previous installed image because the plain internet limit
was absent from the model request. Commit `197ca0cee` changes the prompt.

**PASS — installed instructions, twice.** All nine focused tests passed on rebuilt
image `c9c92d8376363be6c1de511d499b4ff0007c24a73d0c551345049635fcd5a132`.
Each native run made four turns and eight upstream requests through the installed
bridge, without mounting replacement source. The plain internet wording reached
new, loaded, changed-persona and saved threads after restart. The same thread was
retained, and real shell calls completed. Raw request bodies remain outside the
repository in `new-thread.jsonl`, `loaded-thread.jsonl`, `resumed-thread.jsonl` and
`saved-thread.jsonl`, in a separate folder for each run.

**PASS — source gates.** Full typecheck, the event catalogue (175 event types),
Knip (two existing configuration hints), changed-file ESLint without warnings,
changelog lint and Markdown lint passed. The complete package licence check,
all 85 package licence tests and all four source-review tests passed twice.
Computer licence policy tests also passed twice. Fetched `origin/main` was already
included; no rebase was needed or left in progress.

**NOT RUN — fresh real-model/browser journey.** This session carries
`OPENCRANE_FLEET_TASK`. The existing journey guard refuses paid-provider runs from
fleet tasks. Run 3 was a separate operator run without that marker. This task keeps
the marker and guard intact. No secondary stack was claimed, and the owner and
pilot stacks were not touched. Additional model spend is **0 euro cents**.
An operator run is still needed to check real replies at 1280 and 390 px.

**PASS — image checks, twice.** Installed source, file permissions, a fresh Syft
scan, notice collection and the independent notice completeness check passed on
the new digest. Each licence scan accepted all 394 components and collected all
104 installed notices. The licence inventory is unchanged. Package and template
pins, installed-source checksums and the application template checksum now match.
The previous pin was rejected before refresh because the source had changed.

**PASS — GitHub package approvals.** The pushed product commit is
`a02dc5a6b1d998843a856173d10c83f573e9ab8c`.
[Application approval 46097191421](https://github.com/elewa-git/opencrane-new/actions/runs/46097191421)
and [scanner approval 46097191379](https://github.com/elewa-git/opencrane-new/actions/runs/46097191379)
both passed for that exact commit. All four approval/image artifacts were present
and unexpired when checked on 28 November 2026. Their expiry is 29 November 2026.
The CI image fixture job also passed.

**PENDING at writing — full hosted CI.** The final hosted result is recorded on
PR #1223 after the receipt push. Local gates above are complete. Public privacy
and secret scans passed before the product push and run again before this receipt
push. The PR remains draft. A packaged operator rerun must use the approved product
commit while the branch ends in this receipt-only update.

## Run 3 — PARTIAL

**Date:** 28 November 2026
**Install:** Fresh packaged install on slot 1, product commit `b0f109a5d1b39746508f01a0aace3fccbd047994`.
**Package checks:** PASS. Application and scanner approvals were present and current for this product commit. `package-check` passed. `package-up` used the documented `OPENCRANE_ACCEPT_DEV_HOST_RISK=accepted-dev-box-366` switch because this host has swap. Slot 1 was released after the run.

### Run 3 steps and results

1. **PASS — member onboarding.** The member joined, completed all four survey steps, approved
   persona Aster and completed the welcome. Screenshots: `run3-persona-approved-1280.png`
   and `run3-welcome-complete-1280.png`.
2. **PASS — personal chat and Memory off.** The member opened a personal session at 1280 and
   390 px. The composer identified it as private to the member. Personal session defaults
   keep Memory off. The screen captures are `run3-chat-1280.png` and `run3-chat-390.png`.
3. **PASS — assistant identity.** The real model introduced itself as Aster: “Hi Sam, I’m
   Aster, your personal assistant.” See `run3-intro-1280.png`.
4. **FAIL — complete capabilities answer.** It described file sharing, software installation
   and no browser control. It said it could try URLs and that shell networking was restricted,
   rather than plainly saying that internet access is not available yet. See
   `run3-capabilities-390.png`.
5. **PASS — deck shared.** The conversation stream records `Aster_introduction.pptx` as
   uploaded to the chat. The browser could not reload newer messages, so the screenshot
   `run3-deck-1280.png` records that UI error rather than the file card. No “Run interrupted”,
   502 or `127.0.0.1:1` error was observed.
6. **PARTIAL — fetch refusal.** The fetch turn completed in the event stream, but the browser
   timed out waiting for its completion marker and did not display the reply. A plain refusal
   could not be verified; no fetch screenshot is available.

**Runtime checks:** Both computer pods used digest
`sha256:23de7279a36001b3aba97de28b64c01bdff3c7cad8770d7aebb2c3542c58b271`.
`/app/src/assistant-brief.ts` was present. The `computer-runtime` ConfigMap gateway was
`http://10.43.62.135:43000`, not `http://127.0.0.1:1`. The service logs were saved outside the
repository before teardown.

**Spend:** 13 euro cents settled across 11 settlements in the slot 1 budget stream, including
provider setup and the chat turns. This was an operator run with no `OPENCRANE_FLEET_TASK`.

The browser reload failure after the deck was shared matches the conversation-feed
bug fixed in #1225 / PR #1226: `agent.file_publication_started` rows break history
reads. That repair belongs to the separate PR; this change only adjusts the
assistant's explanation of internet access.

## Round 7 — model request investigation

**Root cause: the package installed an older computer image.** The package pin
ended in `40e715076ce0c19f0610b0fbe7872112c971d50a444487126f4465b3d8d4c3f0`.
Its image review dates from 22 October. Its installed `codex-config.ts` has no
assistant brief settings, and `assistant-brief.ts` is absent. Approving a new
application image updates the server and website, but leaves this separate
computer image unchanged.

**PASS — reproduced at the model boundary.** A disposable container ran that exact
package image, its installed bridge and Codex 0.159.2, with a local stand-in model.
The personal turn frame included `assistantKind: personal` and an approved persona.
The captured upstream Responses request contained “You are Codex”. It contained
neither that persona nor `/workspace/artifacts`. The revised native test failed
because the model instructions lacked the approved name. The earlier test mounted
current source over the image, hiding the old installed code.

**PASS — checked app-server behaviour with current source.** The same test with
current installed code captured the approved identity, personal role, socket
restriction and artifacts sharing rule. It also checked a changed persona on a
resumed thread and the saved thread after restarting the computer. In this pinned
version, the top-level Responses `instructions` field is absent. Codex sends the
base instructions and session rules in developer input messages. The existing
`model_instructions_file`, `developer_instructions` and `personality` configuration
works; no alternative thread parameters are needed. The existing unload before a
changed persona takes effect also works. This run does not show missing persona
fields in the server as the cause of the old image's behaviour.

The package check now refuses a computer pin that differs from the released
computer template. It also compares the complete installed source list and its
SHA-256 checksums with the checkout. This catches two matching but old pins.
Both new tests first failed because these differences were accepted.
The native test now uses installed source, without a source mount, and can save
request bodies outside the repository. Raw files include
`old-package-upstream.jsonl`, `new-thread.jsonl`, `loaded-thread.jsonl`,
`resumed-thread.jsonl` and
`saved-thread.jsonl`.

**PASS — rebuilt image and repeat checks.** The package and released template now
use computer digest `23de7279a36001b3aba97de28b64c01bdff3c7cad8770d7aebb2c3542c58b271`.
It was built from product source in `dfa486dd86ef5a278a847bd55e4c67cf22f3c702`.
Installed source and file permissions passed. All 394 components passed the
licence check; all 104 installed notices were collected. No dependency was added.
The native test passed twice on this exact image. Each run made four turns and
eight upstream requests. The thread stayed the same on load, persona change and
restart. All 85 package licence tests passed twice. The server's persona and turn
frame tests passed too. [The safe summary](model-input.json) records request counts,
checksums and which rules reached the model; the full bodies remain outside the
repository.

### Round 7 local checks

| Check | Result |
| --- | --- |
| Installed brief reaches the model on all four thread paths | PASS, twice; eight requests per run |
| Package image and source checks | PASS, 85 tests twice |
| Server persona ownership and turn delivery | PASS, 22 tests |
| Typecheck | PASS, all workspaces, package and development stack; computer checked again after cleanup |
| Event catalogue | PASS, 175 event types |
| Knip | PASS, two existing configuration hints |
| Changed-file ESLint | PASS, no warnings |
| Changelog and Markdown lint | PASS |
| Public privacy and secret scans before push | PASS |
| Fetched main is included | PASS; no rebase needed |
| Application and scanner approvals for `b0f109a5d` | PASS; current artifacts present |
| Fresh packaged model and browser journey | NOT RUN; no valid startup window within 45 minutes |

**Qualification: PARTIAL — authorised stand-in fallback.** The task waited at
least 45 minutes from its first slot checks. Slot 1 first reported free at
23:46:36 UTC. The host load then crossed 6 several times, including 6.07 at
23:49:17, 6.11 at 23:50:22 and 6.64 at 23:50:54. The longest recorded quiet period
was 97 seconds; the rule requires 300 seconds. The final check was at 23:53:04.
There was no valid startup window within the wait. Slot 2 is the live pilot and
was excluded. No slot was claimed, so no stack needed teardown.

The final checks used the exact rebuilt computer image and the installed bridge
with a stand-in model. The captured upstream bodies prove instruction delivery.
They do not prove a real model's reply, a chat file card or the browser layout.
The fresh packaged real-model and 1280/390 px browser checks are **NOT RUN**.
Additional model spend is **0 euro cents**. Previous run 2 screenshots and spend
remain historical evidence below.

The approved product commit is `b0f109a5d1b39746508f01a0aace3fccbd047994`.
Application approval [46083456844](https://github.com/elewa-git/opencrane-new/actions/runs/46083456844)
and scanner approval [46083459643](https://github.com/elewa-git/opencrane-new/actions/runs/46083459643)
both passed. Their approval and image artifacts were present and unexpired.
The hosted image and browser fixture jobs passed. The remaining CI jobs were
still running when this receipt was written; the full hosted result is **PENDING**.
Fetched main `d592e9890742a40abf69d61f81a1c4bcb4297952` is already included, and no
rebase is in progress. The PR remains draft. A later packaged run must use the
approved product commit while this branch ends in receipt changes.

## Run 2 — PARTIAL

**Date:** 27 November 2026
**Install:** Fresh packaged install on slot 1, product commit `3a9e760e4fbead2cb1b49dae36ea2c18157e6ecd`.
**Package checks:** PASS. Application and scanner approvals were present for this commit. `package-check` passed. `package-up` used the documented `OPENCRANE_ACCEPT_DEV_HOST_RISK=accepted-dev-box-366` switch because this host has swap. Slot 1 was released after the run.

### Run 2 steps and results

1. **PASS — member onboarding.** Signed in as the slot 1 member, joined the invited membership, saved all four survey steps, reviewed and approved persona revision 2 with assistant name Aster, and completed the welcome. Screenshots: `member-persona-approved-1280.png` and `welcome-complete-1280.png`.
2. **PASS — personal chat and Memory off.** The chat list reported `assistantKind: personal`. Installed session defaults use `memoryEnabled: false` for personal sessions; personal message requests omit `executionMode`. The desktop and phone chat screenshots are `chat-desktop-1280.png` and `chat-mobile-390.png`.
3. **FAIL — assistant identity.** Despite the approved persona naming Aster, the assistant introduced itself as Codex.
4. **FAIL — capabilities.** The answer described files and software installs, but claimed terminal internet access was enabled. That contradicts the required “no internet yet” answer. It did not claim browser control.
5. **FAIL — shared slide deck.** The assistant offered a `sandbox:` download link. No file card appeared in the chat within five minutes.
6. **PASS — fetch refusal.** Fetching `https://example.com` received a plain failure explanation and did not claim success.

No `Run interrupted`, 502, or `127.0.0.1:8080/v1/responses` message appeared. The `computer-runtime` gateway ConfigMap was not inspected because that trigger did not occur.

**Spend:** 20 euro cents settled today (`todayCents: 20`, `dailyCeilingCents: 2000`, `reservedCents: 0`). The priced provider test reserved 3 cents and settled 1 cent. All amounts are integer cents.

Safe package logs were copied outside the repository before teardown. The receipt contains only the steps, results, small summary JSON and screenshots. No secrets or private paths are included.

Run date: 27 November 2026. Fresh packaged slot: 1. Tested product commit:
`3a9e760e4fbead2cb1b49dae36ea2c18157e6ecd`.

## Run 1 verdict

**PARTIAL — journey blocked before personal chat.** The packaged installation and
provider setup completed. The member's four onboarding answers were saved, and
the approved persona names the assistant Aster. On a later sign-in, both
`/workspace` and `/welcome` reported “Your access has changed”; the selected
personal conversation was unavailable and the New session control was disabled.
The assistant chat prompts were not sent. No real model response, deck, or fetch
result was produced.

The member can see the assigned personal workspace shell, but cannot open a new
session. The receipt includes the unavailable workspace at 1280 px and the earlier approved
persona. A 390 px screenshot was not captured.

## Run 1 access failure investigation

Investigated on 27 November 2026, starting at `dac34cba7`. The fetched main commit
was `d592e9890742a40abf69d61f81a1c4bcb4297952`, already included in this branch.
No rebase was needed. The comparison finished and the development branch was restored.

**PASS — the refusal also occurs on main when the journey selects another account.**
The original onboarding commands supplied `DEV_STACK_ID=1`. The later
`live-journey.mjs` and `probe-member.mjs` launches omitted it. Their sign-in helpers
load configuration and test users from the stack chosen by that variable. Without
it, `identity.ts` selects `owner`, although both scripts still open slot 1's web
address. The selector was checked without opening any private configuration file.

The saved server log shows six `GET /api/chat` requests returning 403, starting at
19:11:19 UTC. Onboarding entry requests also returned 403. The member worker log
shows the survey answers and persona approval, with no later member removal or
role change. No conversation creation or chat message was sent. These requests
were refused before `approvedPersonaReader`, `assistantTurnIdentity` or the
computer's `readAssistantIdentity` could run.

The HTTP test uses real disposable NATS, PostgreSQL and OpenFGA.
[The check results](access-checks.json) record the tested commits and local gates. It projects a
joined member and compares two signed-in accounts in the same organisation:

| Check | This branch | Main |
| --- | --- | --- |
| Expect chat access after selecting the other stack's account | FAIL: expected 200, received 403 | FAIL: expected 200, received 403 |
| Select the joined slot member's account | PASS: chat returns 200 | PASS: chat returns 200 |
| Other account signs in, then reads chat and onboarding | PASS: sign-in returns 200; protected reads return 403 | PASS: same results |
| Render the protected read's 403 in the workspace | PASS: access-changed message and disabled New session | PASS: same message and disabled control |

The failing test is reproduced by running `journey-identity.test.ts` with
`JOURNEY_TEST_SUBJECT=other-stack-subject`. With the default joined account, both
HTTP tests pass. `provisioning.spec.ts` checks the exact message and disabled
button. Assertions and access checks were kept intact.

The comparison points to the previous journey's account selection. It does not
show a product regression in this PR or the accepted-message receipt problem
reported in #1215. No product fix was made. Work stopped after the baseline comparison, as requested.
A fresh packaged rerun is **NOT RUN**. No secondary stack was claimed, changed or
stopped. The brief slot wait was cancelled because the baseline comparison calls
for a stop, rather than treating a busy slot as a blocker. Any later journey must
supply `DEV_STACK_ID=1` to every browser script, including sign-in probes.

The original service logs remain outside the repository. Copies of
`server-676b55779c-7kmjz.log` and `worker-members-7948cff9df-hzrct.log` were kept with
`account-context.json`, `branch-identity-red.log`, `main-identity-red.log`,
`branch-identity-green-1.log`, `branch-identity-green-2.log`,
`main-identity-green.log`, `web-reproduction-1.log`, `web-reproduction-2.log`
and `main-web-reproduction.log`. These files contain the detailed local evidence.

## Run 1 steps and results

| Step | Result | Evidence |
| --- | --- | --- |
| Rebase on current `origin/main` including #1216; push corrected head | PASS | Product commit `3a9e760e4fbead2cb1b49dae36ea2c18157e6ecd` |
| Application package approval for tested product commit | PASS | Run `46047237181`; approval and image artifacts present |
| Scanner package approval for tested product commit | PASS | Run `46047241881`; approval and image artifacts present |
| Fresh slot-1 packaged install and package check | PASS | Package installed in slot 1; no slot 2 or pilot changes |
| Runtime gateway ConfigMap | PASS | `http://10.43.161.221:43000` |
| Member onboarding survey, all four answers | PASS | Answers saved during setup |
| Approved persona with assistant name Aster | PASS | [Approved persona screenshot](persona-approved-1280.png) |
| Complete saved welcome and enter personal chat | FAIL | Welcome and workspace both showed access changed; New session disabled |
| Memory-off personal chat at 1280 and 390 px | NOT RUN | No chat turn could be started |
| Assistant introduces itself as Aster, not Codex | NOT RUN | No chat turn could be started |
| Truthful capabilities: shared files, software installs, no internet, no browser control | NOT RUN | No chat turn could be started |
| Create and share a short slide deck | NOT RUN | No chat turn could be started |
| Graceful refusal to fetch `https://example.com` | NOT RUN | No chat turn could be started |

[Workspace unavailable at 1280 px](workspace-unavailable-1280.png)

## Run 1 spend and stack handling

Recorded spend was **1 euro cent** (`settledCents: 1`) across one settled event.
This was provider verification/setup; no chat prompt was sent. The reserved total
was 1 cent. Amounts are integer cents from `budget-dev` events.

Package-up used the documented dev-host risk override
`OPENCRANE_ACCEPT_DEV_HOST_RISK=accepted-dev-box-366`. The package failure from
the earlier stand-in-only attempt was recorded safely as a fleet-stand-in refusal;
its raw failure record and the fresh stack service logs were kept outside the
repository. The fresh provider-mode install and `package-check` then passed.

No “Run interrupted”, 502, or `127.0.0.1:8080/v1/responses` error appeared. The
ConfigMap gateway value was checked after the access failure and remained the
service address shown above.

## Run 1 checks

| Check | Result |
| --- | --- |
| Application package approval on product commit | PASS |
| Scanner package approval on product commit | PASS |
| Fresh packaged install and package check, slot 1 | PASS |
| Onboarding answers and approved persona | PASS |
| Personal chat access after welcome | FAIL |
| Real-model chat prompts and Memory-off verification | NOT RUN |
| Desktop/mobile chat screenshots, deck sharing, fetch refusal | NOT RUN |
| Mobile screenshot | NOT RUN; stack released after access failure |
| Paid chat usage | NOT RUN; recorded setup spend is 1 cent |
| Hosted CI for the tested product commit | FAIL; shard 1 setup hook timed out and shard 3 kubectl process was terminated |
