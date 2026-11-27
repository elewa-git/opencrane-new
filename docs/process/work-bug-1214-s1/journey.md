# Welcome survey saves after a pause

Journey on a fresh dev stack: PASS

The fresh packaged install ran in slot 1 on commit
`4c55e5d79f3f0813d61ee5dab89c94578e51967e`. CI and both image approvals
passed for that commit.
[CI](https://github.com/elewa-git/opencrane-new/actions/runs/45962567585) ·
[Application](https://github.com/elewa-git/opencrane-new/actions/runs/45962616071) ·
[Scanner](https://github.com/elewa-git/opencrane-new/actions/runs/45962615869)

1. The owner signed in and invited two new members. Each member signed in through the browser.
2. At 1280 px, the first member saved their name, work, style and tasks. The browser paused for
   at least 80 seconds between saves, longer than the server's 72-second idle timeout.
3. At 390 px, the second member saved the same four steps with the same pauses. At both
   widths the browser showed **Your survey is saved** and **Review saved persona**. Reopening
   the page kept the saved screen and sent no additional save.
4. The screenshots were copied before the package was removed. Slot 1 reported free afterwards.

| Width | Replies for steps 1–4 | Pauses between saves (seconds) | Screenshots |
| --- | --- | --- | --- |
| 1280 px | 200, 200, 200, 200 | 80.114, 80.094, 80.100 | [Start](survey-start-1280.png) · [Saved](survey-saved-1280.png) |
| 390 px | 200, 200, 200, 200 | 80.100, 80.099, 80.097 | [Start](survey-start-390.png) · [Saved](survey-saved-390.png) |

Both installs used the documented development host exception for swap,
`OPENCRANE_ACCEPT_DEV_HOST_RISK=accepted-dev-box-366`. Slot 1 was free
and the one-minute load stayed below 6 for five minutes before each claim.

The first install returned HTTP 200 for the first desktop save. The browser
driver stalled before it recorded the result. Its logs and screenshot were
saved before the stack was removed. The second install used a driver that
checked the HTTP status and the saved screen.
[First attempt](first-attempt-start-1280.png).
