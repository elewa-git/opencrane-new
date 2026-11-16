# First browser attempt

Date: 15 November 2026. Source: `3876b11849572744b38d968d95b9fe9f9736e155`.
Fresh secondary stack 2. Overall journey: FAIL.

Fresh startup, browser installation, personal-key review, grants and publication passed.
At 1280 px the member verified and chose their key, used the live tool, switched their
own assistant off with the keyboard, saw the refusal and My tools link, switched it
back on and used the tool again. Those browser steps completed.

At 390 px the member verified and chose another profile and completed a live tool
call. The collector stopped during the next consent click, before receiving its
selection response. The screenshot shows a pending change and the last confirmed
checkbox value. The phone refusal, phone restoration and final saved-event checks
were NOT RUN in this attempt. This attempt cannot qualify the slice.

The collector used Playwright `setChecked` on the phone. Its immediate value check
conflicts with the control's deliberate behaviour: keep the confirmed value until
the save reply arrives. An isolated browser probe reproduced that rejection for a
checkbox waiting for confirmation. A plain click followed by a confirmation wait
succeeded. The collector was corrected; product code and deadlines were unchanged.
The complete journey must run again on a fresh stack.

[Failure step and response statuses](failure.json), [desktop observations](observations.json)
and [phone failure screenshot](failure-390.png) retain the failed attempt.
`down.sh` completed with status 0; the slot subsequently reported `free`.
