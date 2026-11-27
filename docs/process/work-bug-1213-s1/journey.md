# Invitation acceptance after reinstalling

**NOT RUN** with a fresh cookie key on the second install. The corrected retry
reached the two-hour wait limit for the slot and host load. Slot 1 was sometimes
busy. While it was free, the one-minute load did not stay below 6 for five
minutes in time for the retry.

## First attempt

The slot-1 packages used source commit
`27cf28fa8f073d17016c4dd68c74de82ff5d3435`. The scanner and application
artifacts were present. Startup used the documented development-host exception
`OPENCRANE_ACCEPT_DEV_HOST_RISK=accepted-dev-box-366`.

| Step | 1280 px | 390 px |
| --- | --- | --- |
| Sign in on a fresh package | PASS | PASS |
| Verify a fresh cookie key after reinstalling | FAIL | NOT RUN |
| Sign in again with the earlier browser cookies still present | NOT RUN | NOT RUN |
| See the expiry message and sign in from the invitation | NOT RUN | NOT RUN |
| Accept the invitation | NOT RUN | NOT RUN |

The browser kept both signed-in windows open while the package was removed and
installed again at the same address. The runner used `package-down` between the
two installs. That removed the package and kept the slot's private settings, so
the second install reused the cookie key. The browser stopped at the first
post-reinstall check. The corrected runner uses `down.sh --id 1` and a fresh
claim between installs.

The startup logs `first-up.log` and `second-up.log` and the load samples in
`load-wait.log` are retained outside the repository. The service log collector
failed to save the service logs before the package was removed. No screenshots
were taken because the run did not reach the invitation outcomes.

Final package and slot teardown for the first attempt passed. Slot 1 reported
free afterwards. The corrected retry did not claim a slot.
