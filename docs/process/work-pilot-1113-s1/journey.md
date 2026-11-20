# Install hardening journey

Journey on a fresh dev stack: NOT RUN

Date: 20 November 2026. Source implementation: `08071525c`.

## Installation precheck

The read-only application-image approval check returned
`Application CI approval refused` at its metadata stage. The package requires a
successful packaging workflow for the exact checkout commit and branch. At the
precheck, the branch was unpublished and had no such output. The workflow query
also returned no matching run for this source commit. The same approval consumer runs during
package preparation and preflight. The guard was kept intact.

[Safe guard output](image-approval.txt) records only the operation, stage and
fixed refusal. It omits the process, machine name and private paths.

No secondary slot was claimed or started. The initial status check found slot 1
running and slot 2 free, and the load was above 6. No package stack, live test hostname,
certificate or listener was created. The image precheck refused before any
fresh-stack claim, so no five-minute load qualification was attempted.
There was no owned slot to tear down and no startup or service log to copy.
No screenshot was produced. No DNS, internet exposure, sign-in organisation,
existing person or instance setting was changed. Neither the Zitadel key nor a model-provider key was read.

## Required live steps

| Step | Result |
| --- | --- |
| Wait for both slots and all package stacks to be free; load below 6 for five minutes | NOT RUN |
| Claim a fresh spare slot, then use the guarded package commands | NOT RUN |
| Install with a tailnet-only test hostname and self-signed certificate | NOT RUN |
| Observe each unsafe production sign-in setting refuse before Helm | NOT RUN live; covered by source tests |
| Right-organisation person signs in and chats at 1280 px | NOT RUN |
| Right-organisation person signs in and chats at 390 px | NOT RUN |
| Verify Secure and HttpOnly session cookie | NOT RUN live |
| Wrong-organisation person is refused without a member being created | NOT RUN |
| Claim the first owner with the one-time token | NOT RUN live; existing claim integration tests run |
| Submit the same token again and observe refusal | NOT RUN live; existing claim integration tests run |
| Copy screenshots and safe logs before teardown | NOT RUN; no stack or captures existed |

This slice cannot merge with this journey verdict. Source tests and Helm fixture
checks do not substitute for the fresh running-product journey. The real public
address, DNS and certificate issuance remain outside this slice.
