# First invitation after claiming the installation

Journey on a fresh dev stack: NOT RUN

The two fresh slot 1 package installs are pending CI and both exact-commit
image approvals.

| Step | 1280 px | 390 px |
| --- | --- | --- |
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
