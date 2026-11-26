# My tools on a fresh dev stack

## Fresh slot 1 journey rerun 2

**Fresh-stack journey — PARTIAL.** Tested on 26 November 2026 at
`2e1827dbd06f2100ef042cdd455daa5e48b9bf73`.

| Step | 1280 px | 390 px |
| --- | --- | --- |
| Start a fresh stack and its two local TLS fixtures | FAIL | PASS |
| Create and accept the admin and two member invitations through the API | NOT RUN | PASS |
| Open My tools from Settings and see the empty list | NOT RUN | [PASS](rerun2-empty-390.png) |
| Discover the personal-key server | NOT RUN | PASS |
| Review the tool modes and audience | NOT RUN | FAIL |
| Publish both tool servers | NOT RUN | NOT RUN |
| See Needs your account and Ready for you | NOT RUN | NOT RUN |
| Verify and select a key, then see Ready for you | NOT RUN | NOT RUN |
| See Not available to you and the access message for both tools | NOT RUN | NOT RUN |

The desktop attempt stopped in the development owner bootstrap after five
ownership migration conflicts. In the phone attempt, the admin and both
members signed in with separate fixture accounts. All six calls to create and
accept the invitations returned HTTP 200. The admin discovered the personal-key
server before the driver stalled on a visually clipped radio input. The driver
now clicks the visible mode label, as the existing integration screen checks do.

The corrected browser run is **NOT RUN**. A later retry reached four and a half
minutes of the required five-minute load window before another job took slot 1.
The wait ended before the slot and load checks cleared again, leaving too
little time for another fresh run within the 90-minute limit.

Local checks passed for 155 focused My tools and connection-selection tests,
typecheck, changed-file ESLint, Markdown lint, Knip, event catalogue,
whole-stream reads and changelog.

Startup, service and browser logs were saved before teardown, including
`startup.log`, `service-last-error.log`, `service-stage-b-server.log` and
`browser-diagnostics.log`. Slot 1 reported free after teardown.

## Fresh slot 1 rerun

**Fresh-stack journey — FAIL.** Run on 26 November 2026 at
`f0deaa22d3bc6161cbd15725e7bbc84eb3e35005`.

| Step | Verdict |
| --- | --- |
| Fresh startup and both local HTTPS fixtures ready | PASS |
| Admin accepts the fixture invitation | PASS |
| Admin opens the People page to invite the test member | FAIL |
| Admin adds and publishes the personal-key and no-key servers | NOT RUN |
| Member sees both statuses at 1280 px and 390 px | NOT RUN |
| Member selects a personal key and sees Ready for you | NOT RUN |
| Member without grants sees Not available to you at both widths | NOT RUN |

Invitation acceptance returned HTTP 200 at 18:53:12 UTC. The People page's
members directory read returned HTTP 403 one second later. The page only shows
**Invite people** when that read grants permission, so the browser timed out
waiting for the button. The exact reason for the directory refusal is unknown.
The run ended before any tool was added or any screenshot was taken.

Startup and service logs were saved before teardown. The private copies include
`startup.log`, `service-stage-b-server.log` and `browser-diagnostics.log`.
Slot 1 was stopped and reported free.

## Previous fresh-stack attempts

Tested source commit: `9306fee13db8be1b98b7493303a5822fb0823fba`.

| Step | 1280 px | 390 px |
| --- | --- | --- |
| Member opens My tools from Settings and sees the empty list | [PASS](empty-1280.png) | [PASS](empty-390.png) |
| Member sees the name and status of each published tool | NOT RUN | NOT RUN |
| Member selects their own key and sees Ready for you | NOT RUN | NOT RUN |
| Member without grants sees Not available to you | NOT RUN | NOT RUN |

### What happened

1. Fresh slot 1 startup and the local HTTPS fixtures passed. The built-in
   approval demo was deferred so the register started empty. The member's
   empty-state screenshots were saved at both widths.
2. The first browser run stopped at the admin's Add link. The driver used an
   earlier label. After that was corrected, the next run reached tool discovery.
   It stopped at a second outdated selector for the Allow automatically radio.
3. The third fresh run stopped while the member without grants opened the
   invitation sign-in page. The one-minute host load was above 20 when checked.
   The driver was changed to wait for startup load to settle before the browser
   steps and check the second member after key selection.
4. The fourth attempt was NOT RUN. Slot 1 did not become available with a
   full five minutes of one-minute load below 6 before the two-hour window
   ended. Setup stopped before claiming a slot.

Each claimed stack was stopped and slot 1 reported free. Startup and service
logs were saved before teardown. The private copies include `startup.log`,
`service-stage-b-server.log` and `browser-diagnostics.log`.
The pilot stack was left alone.
