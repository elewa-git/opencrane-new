# Welcome survey saves after a pause

Journey on a fresh dev stack: PASS

The fresh packaged install ran in slot 1 on 27 November 2026, using commit
`4c55e5d79f3f0813d61ee5dab89c94578e51967e`. CI and both image approvals
passed for that commit. Both approval runs still had unexpired artifacts before preparation.
[CI](https://github.com/elewa-git/opencrane-new/actions/runs/45962567585) ·
[Application](https://github.com/elewa-git/opencrane-new/actions/runs/45962616071) ·
[Scanner](https://github.com/elewa-git/opencrane-new/actions/runs/45962615869)

The branch tip was kept on a backup branch while the packaged check ran on that
approved product commit. The tip was restored before this receipt was committed.
The later fixture comment changes no behaviour.

1. Slot 1 was free and the one-minute load stayed below 6 for five minutes before
   `claim.sh --id 1`. Slot 2 was the live pilot and was excluded from the capacity check.
2. With `DEV_STACK_ID=1`, the run used `run.sh package-prepare --id 1`, the private
   `prepare.ts` command and its values file, then `run.sh package-up --id 1` with that
   values file supplied once. This created a fresh packaged install. It used the documented
   development host exception, `OPENCRANE_ACCEPT_DEV_HOST_RISK=accepted-dev-box-366`.
3. `run.sh package-check --id 1` passed. The package forwarder started. The owner signed in
   and invited two new members. Each member signed in through the browser.
4. At each width, the member saved their name and received HTTP 200. A separate browser
   with no session cookie then sent a survey save with a different name. The request used
   `credentials: omit`, the current survey generation and the current saved position.
   Both requests returned HTTP 401. The separate browser showed **Your session has expired**.
5. Reloading as the signed-in member returned exactly the same saved survey as before
   the refusal, including its generation, position, saved time and answers. One step
   was saved before and after. Opening the name step showed the original name.
6. The member continued through work, style and tasks. All four signed-in saves returned
   HTTP 200 at each width. The browser paused for at least 80 seconds before steps 2–4,
   longer than the server's 72-second idle timeout. This included a signed-in save after
   the refused request. Reopening the completed survey kept **Your survey is saved** and
   **Review saved persona**, with no additional save.
7. The screenshots and small result file were copied before `run.sh package-down --id 1`
   and `down.sh --id 1`. Both cleanup commands passed and slot 1 reported free afterwards.

| Width | No-cookie save | Saved state after member reload | Screenshots |
| --- | --- | --- | --- |
| 1280 px | 401; no session cookie | Unchanged; Casey Pilot; one saved step | [Refused](survey-refused-1280.png) · [Earlier answer](survey-unchanged-1280.png) |
| 390 px | 401; no session cookie | Unchanged; Morgan Pilot; one saved step | [Refused](survey-refused-390.png) · [Earlier answer](survey-unchanged-390.png) |

| Width | Signed-in replies for steps 1–4 | Pauses before steps 2–4 (seconds) | Screenshots |
| --- | --- | --- | --- |
| 1280 px | 200, 200, 200, 200 | 80.099, 80.099, 80.099 | [Start](survey-start-1280.png) · [Saved](survey-saved-1280.png) |
| 390 px | 200, 200, 200, 200 | 80.100, 80.097, 80.100 | [Start](survey-start-390.png) · [Saved](survey-saved-390.png) |

The [small result file](refusal-and-idle-results.json) records the status codes, pause
lengths, empty cookie count and unchanged saved state checks. Raw logs stay outside the
repository as `capacity.log`, `package-up.log`, `package-check.log` and `browser.log`.

An earlier fresh install returned HTTP 200 for the first desktop save, but the first
browser driver stalled before recording its result. Its logs and screenshot were saved
before cleanup. That attempt was incomplete. The fresh run above supplies the refusal,
unchanged answers and idle saves at both widths.
[First attempt](first-attempt-start-1280.png).
