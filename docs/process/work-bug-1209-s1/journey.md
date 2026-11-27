# First invitation after claiming the installation

Fresh slot-1 packaged journey — **PARTIAL**. The 390 px journey passed.
At 1280 px the owner could open People and send the first invitation. The
browser script stopped at the welcome survey before checking the member's refusal.

Both packages ran product commit `36d6287dc61ba2d744056fe75cf27674e54e5f98`.
Slot 1 was claimed at 05:59 UTC for desktop and 06:17 UTC for mobile on
27 November 2026. Each claim followed five minutes with the one-minute load
below 6. Each package created seven new data volumes and used a new one-time
owner token.
[Application approval](https://github.com/elewa-git/opencrane-new/actions/runs/45947738743) ·
[Scanner approval](https://github.com/elewa-git/opencrane-new/actions/runs/45947738708)

| Step | 1280 px | 390 px |
| --- | --- | --- |
| Start a fresh package in slot 1 | PASS | PASS |
| Claim the empty installation in Chromium | PASS · HTTP 201 | PASS · HTTP 201 |
| Open People and see **Invite people** | PASS · 425, 425, 200 | PASS · 425, 200 |
| Send the first invitation and see the link | PASS · HTTP 200 | PASS · HTTP 200 |
| Accept the invitation as an ordinary member | PASS · HTTP 200 | PASS · HTTP 200 |
| Open People as that member and find **Invite people** hidden | NOT RUN | PASS · HTTP 403 |
| Send an invitation as that member | NOT RUN | PASS · HTTP 403, `access_refused` |
| Remove the disposable package | PASS | PASS |

The owner's People page never showed an error during either wait. The invitation
requests followed the claim response by 3.78 seconds on desktop and 2.69 seconds
on mobile.

After the desktop member joined, the site opened the welcome survey. The script
was still waiting for the previous acceptance heading and timed out. I stopped
mobile preparation before Helm started and updated the script to choose
**Skip welcome setup**. The mobile run completed the refusal check. After resizing
that browser to 1280 px on the same installation, the member received another
HTTP 403 with `access_refused`. The desktop result above covers the original
fresh desktop installation.

Both installs recorded the documented `accepted-dev-box-366` exception for
host checks F1 and F2. Both temporary sign-in apps were removed. Startup and
service logs were saved before teardown. The mobile launcher exited 124 after
the browser completed and wrote its teardown result. A separate check confirmed
that the volumes differed and that slot 1 was free. The desktop timeout is in
`browser-1280.log`.

[Result data](results.json) · [Desktop invitation](invitation-created-1280.png) ·
[Desktop welcome survey](member-welcome-1280.png) ·
[Mobile invitation](invitation-created-390.png) · [Mobile refusal](member-refused-390.png)

The server test reproduced HTTP 503 with `membership_applying` when the
ownership worker saved its event during the read. The web test reproduced
the error page when the usual wait ended with access still being set up.
Both tests were committed before the fix. The same server test returned
HTTP 200 too early when the ownership receipt check was temporarily removed.
It passed again after that check was restored.

Both focused server runs passed 307 tests each. Both People web runs passed
204 tests each. Typecheck, the event catalogue, Knip, scoped ESLint, Markdown
lint, changelog lint, the whole-stream read check and the README check passed.
