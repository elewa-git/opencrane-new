# First invitation after claiming the installation

Journey on a fresh dev stack: NOT RUN

Product commit `fb932db61ef16f21a26921fa68b42c0d90ca8a16` passed hosted CI
and both package image approvals. The image artifacts were available.
[CI run](https://github.com/elewa-git/opencrane-new/actions/runs/45926426186) ·
[Application approval](https://github.com/elewa-git/opencrane-new/actions/runs/45926457320) ·
[Scanner approval](https://github.com/elewa-git/opencrane-new/actions/runs/45926457185)

On 27 November 2026, slot 1 and host load failed to meet the startup
condition within the two-hour wait. Slot 1 needed to stay free while
one-minute load stayed below 6 for five minutes. The longest observed
stretch was 4 minutes 57 seconds. Slot 1 was busy at the next check. All
199 samples are in the private `capacity.log`. This task claimed no slot
and took no screenshots.

| Step | 1280 px | 390 px |
| --- | --- | --- |
| Start a fresh package in slot 1 | NOT RUN | NOT RUN |
| Claim an empty package with its one-time token | NOT RUN | NOT RUN |
| Open People immediately and create the first invitation | NOT RUN | NOT RUN |
| Accept the invitation and confirm an ordinary member receives HTTP 403 when inviting | NOT RUN | NOT RUN |

The earlier journey recorded HTTP 201 on the claim, then HTTP 503 on the
first invitation. The ownership event was saved while the permissions
worker was still applying it. The new HTTP test holds back the worker at
that point and reproduces the 503. It also checks the periods before the
member table and ownership worker finish.

The invitation waits up to five seconds for an account that made a claim
within the past 30 seconds. The server names the dependency it is waiting
for in a private log. The normal role and permission checks still run
before the invitation is saved.

Both local runs passed 171 focused tests. The new test also caught a
temporary removal of the claimant identity check. Hosted CI passed when
the failed gateway test shard was rerun on the same commit.
