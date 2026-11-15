# First fresh rework attempt

Journey on a fresh dev stack: FAIL

Tested source: `cd3a999ab22772abb8a0854ddbe5475bee2e59c2`, 15 November 2026.
Claimed secondary stack 2. Fresh startup and status passed. Both complete browser
sequences passed at 1280 and 390 pixels: live call, consent off, completed refusal
with My tools link, consent on and restored live call. The consent screens showed
no profile warning after the confirmed changes.

The collector then required every profile-list reply to be HTTP 200. That failed:
the private server log recorded one 503 at 12:45:57 UTC, before the first consent
off at 12:46:30 UTC. The collector's last step label still named the completed
390-pixel tool call; the failing assertion was the following profile-status check.
Saved-event verification was NOT RUN in this attempt. Its last responses and
browser state remain in [failure record](rework-attempt-1-failure.json) and [last browser state](rework-attempt-1-failure-390.png).

A new real-store HTTP test reproduced 503 after selection alone with the profile
already indexed and its projection paused. The reader still required the projection
to process every connection event, including selection events which add no inventory.
The subsequent fix checks the unprojected events for profile creation and preserves
refusal for an unindexed creation. The all-200 journey assertion was retained.

The cleanup trap ran `down.sh` successfully, status 0. This was another attempt
inside board rework round 1 of 2, not another delivery-rule move into Fixing.
