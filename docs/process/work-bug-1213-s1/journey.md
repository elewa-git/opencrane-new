# Invitation acceptance after reinstalling

**NOT RUN** to completion on a fresh packaged journey. The retry stopped before
14:15 UTC because the required five-minute low-load window did not return in
time to complete both installs. Slot 1 was free and `down.sh --id 1` returned
`free`.

## Journey evidence

| Step | 1280 px | 390 px |
| --- | --- | --- |
| Sign in on install 1 | PASS | PASS |
| Tear down the whole slot and install again at the same address | PASS | PASS |
| Sign in on install 2 while the old browser cookies remain | PASS | NOT RUN |
| Avoid the uncertain message and return to the invitation | NOT RUN | NOT RUN |
| Explain the invitation 401 and return to the same invitation after sign-in | PARTIAL | NOT RUN |
| Accept the invitation with stale scoped cookies still present | NOT RUN | NOT RUN |

The first packaged attempt used the receipt-only commit. Package preparation
refused it, so no journey started. The next attempt used the last approved
product commit, `27cf28fa8f073d17016c4dd68c74de82ff5d3435`. Install 1 sign-in
passed at both widths. The runner then removed the package and ran
`down.sh --id 1` before installing again at the same address. Install 2 was
reachable, and the 1280 px browser signed in and replaced its root cookie while
retaining the earlier scoped cookies.

The 1280 px expiry check timed out before it could confirm the 401
message and return link. A later diagnostic run showed that the runner
inspected the page while the provider callback was still redirecting. The
private journey runner now waits for the same invitation URL and its form after
sign-in. That corrected runner could not claim slot 1 before the cutoff. It did
not produce a passing return-path or invitation-acceptance result.

The service-log collector saved the safe service and pod logs for failed runs.
It did not block this receipt and was not changed. `first-up.log`, `second-up.log`, `pods.log`, `service-server-*.log` and
`browser-result.json` remain in the task receipt outside the repository. The development-host
exception `OPENCRANE_ACCEPT_DEV_HOST_RISK=accepted-dev-box-366` was used for
package startup.

## Teardown

The final wait ended without a slot claim. `down.sh --id 1` returned `free`.
The other slot was the marked live pilot and was not touched. The slot-and-load
wait began at 13:34 UTC and stopped before the 14:15 UTC cutoff. No invitation
screenshots were captured.
