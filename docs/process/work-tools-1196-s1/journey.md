# My tools on a fresh dev stack

Journey on a fresh dev stack: FAIL

Tested source commit: `9306fee13db8be1b98b7493303a5822fb0823fba`.

| Step | 1280 px | 390 px |
| --- | --- | --- |
| Member opens My tools from Settings and sees the empty list | [PASS](empty-1280.png) | [PASS](empty-390.png) |
| Member sees the name and status of each published tool | NOT RUN | NOT RUN |
| Member selects their own key and sees Ready for you | NOT RUN | NOT RUN |
| Member without grants sees Not available to you | NOT RUN | NOT RUN |

## What happened

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
