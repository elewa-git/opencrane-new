# First send in a new assistant session

**NOT RUN.** The application and scanner approvals passed after rebasing onto
main, which includes #1216. The fresh packaged journey could not start because
slot 1 was not acquired within the two-hour wait limit.

## Approved images

Both approvals used product commit
[`267a650b3`](https://github.com/elewa-git/opencrane-new/commit/267a650b368e41764854819cfa20c11d055b55b7).
Their approval and image artifacts were checked and remained available before
the claim attempt. This round rebases the existing fix and records its checks.

| Check | Verdict | Evidence |
| --- | --- | --- |
| Application approval | PASS | [Application run](https://github.com/elewa-git/opencrane-new/actions/runs/46046864660) |
| Scanner approval | PASS | [Scanner run](https://github.com/elewa-git/opencrane-new/actions/runs/46046869143) |
| Hosted product CI | PASS | [CI run](https://github.com/elewa-git/opencrane-new/actions/runs/46046823012) |

## Slot wait

The wait ran from 18:06 to 20:06 UTC on 27 November 2026. Slot 2 was the live
pilot and was excluded from the wait. Slot 1 was checked throughout.

A five-minute low-load window completed while slot 1 was free. The explicit
`claim.sh --id 1` attempt did not acquire it. The next ownership check showed
another worktree's claim. Waiting continued until the original two-hour limit.
The last check still showed a busy slot and a one-minute load of 10.09.

This task acquired no stack. Package preparation, installation and browser checks
never started. There was no owned stack to tear down. The
[small result summary](results.json) records the counts and verdicts. Raw output
stays outside the repository in `slot-wait.jsonl` and the named check logs below.

## Browser checks still required

The journey needs a fresh packaged install in slot 1 with the approved commit
checked out. A new Kubernetes namespace keeps its services separate. New storage
volumes keep earlier chats out of the run. The journey uses the startup recipe in
[the package notes](../../../infra/package/README.robot.md).

1. The owner invites a new member. The member accepts and opens the workspace.
2. At 1280 px, the member opens three new sessions in a row, sends the first
   message in each and checks that no uncertain-send warning appears. Each
   message remains after reloading.
3. At 390 px, the member repeats those steps in three more new sessions.
4. At each width, a real browser network failure keeps the draft and shows a
   clear message. Retry saves the message once after the connection returns.
   A failure before session creation also keeps the draft and offers Retry.

| Live check | Verdict |
| --- | --- |
| Fresh packaged install | NOT RUN |
| New-session sends at 1280 px | NOT RUN |
| New-session sends at 390 px | NOT RUN |
| Clear messages for real failures at both widths | NOT RUN |
| Live screenshots | NOT RUN |

## Local checks

| Check | Verdict | Evidence |
| --- | --- | --- |
| Server regression | PASS | Two runs against the required shared test database; `server-2.log` and `server-3.log`. |
| Workspace tests | PASS | Two runs of all 119 tests; `workspace-1.log` and `workspace-2.log`. |
| Chromium fixtures | PASS | Two runs at 1280 and 390 px; `chromium-1.log` and `chromium-2.log`. These are local fixtures. |
| Typecheck, event catalogue and Knip | PASS | `typecheck.log`; 175 event types agreed; Knip exited zero. |
| Changed-code ESLint | PASS | No warnings; `eslint.log`. |
| Markdown, README, changelog and whole-stream reads | PASS | No failures. |

## Work log

Rebased the existing test and fix commits onto main and confirmed completion.
Pushed the product commit and dispatched both approval workflows. Repeated the
focused checks, waited for slot 1 and kept the live checks explicitly NOT RUN.
The remaining blocker is the fresh packaged journey.
