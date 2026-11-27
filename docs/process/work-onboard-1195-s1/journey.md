# Onboarding and Memory

## Earlier Helm journey

**PASS on a fresh Helm install.**

On 26 November 2026, a fresh Helm install on slot 1 used commit
`464989640d2ae317c63d9d5cba3bd58c4380374f`. The ownership check passed. Ordinary
chats used the free stand-in. The welcome ran from its saved script. The installer
logged the documented `OPENCRANE_ACCEPT_DEV_HOST_RISK=accepted-dev-box-366`
exception for swap and crash dumps.

The run used `claim.sh --id 1`, `run.sh package-prepare --id 1`, the package
preparation script, `run.sh package-up --id 1` and
`run.sh package-check --id 1`. The package forwarder connected the browser to the
new installation.

| What passed | 1280 × 900 | 390 × 844 |
| --- | --- | --- |
| An invited member accepted the invitation. The survey opened after sign-in from the workspace link. | [`/workspace/`](survey-1280.png) | [`/workspace/conversations`](survey-390.png) |
| The member saved one answer. Signing in from the other workspace link reopened the survey at the second step. | [`/workspace/conversations`](survey-resumed-1280.png) | [`/workspace/`](survey-resumed-390.png) |
| The member saved all four answers and approved the persona. | [Persona](persona-1280.png) | [Persona](persona-390.png) |
| The member answered the welcome question and reached its completed state. | [Completed welcome](welcome-1280.png) | [Completed welcome](welcome-390.png) |
| Sign-in opened the requested workspace page after setup. The member received their first chat reply on the computer that was already running during the survey. | [Before sending](before-chat-1280.png), [Completed chat](first-chat-1280.png) | [Before sending](before-chat-390.png), [Completed chat](first-chat-390.png) |
| The member saved a fact in Memory and saw it after reloading. | [Saved fact](memory-1280.png) | [Saved fact](memory-390.png) |
| A signed-out browser saw a sign-in prompt and the survey request returned 401. | [Sign-in prompt](signed-out-1280.png) | [Sign-in prompt](signed-out-390.png) |

The owner saved a skip and then signed in from a workspace link at both widths.
Each member kept the same computer and pod identity, start time and restart count
from the survey through the first reply. [Browser checks](result.json)

Kubernetes denied GET and POST exec requests from the dispatcher to the server
and file worker pods. The dispatcher could run a harmless command in each member's
computer pod. Kubernetes also refused to give a non-computer pod a name reserved
for computers. The file worker had no pod creation or server exec permission.
[Permission checks](worker-authorisation.json)

Tests with a controlled clock covered first messages in personal assistant,
shared-assistant and direct chats. They also checked the one-hour limit from joining
when the worker reads the join later and the member continues saving survey answers.

Two earlier installations stopped before the browser checks. The first driver
used a status command that checks Compose processes. The second driver expected
a different spelling of the Kubernetes status even though the server pod request
was denied. Both runs saved startup and service logs before cleanup.

`run.sh package-down --id 1` and `down.sh --id 1` both passed. Slot 1 reported free.

## Direct workspace visits

### Run 1

**PARTIAL on a fresh slot-1 Compose stack.** On 26 November 2026, the stack
started from `13c6ea3e1` with the free model stand-in. The slot's own test owner
claimed the installation through the browser and had access to the computer list.
The browser used the normal invitation flow for members.

| Check | 1280 × 900 | 390 × 844 |
| --- | --- | --- |
| Signed-out survey request returns 401 | PASS | PASS |
| Owner creates the invitation and the member joins and opens the survey | FAIL | [PASS](routing-survey-390.png) |
| Member saves the first answer while the personal computer runs | NOT RUN | PASS |
| Signed-in unfinished member opens the Conversations bookmark and returns to survey step two | NOT RUN | PARTIAL |
| Reload of Conversations returns the unfinished member to survey step two | NOT RUN | NOT RUN |
| Member saves all survey answers, approves the persona and completes welcome | NOT RUN | NOT RUN |
| Finished member keeps Conversations on a direct visit and reload | NOT RUN | NOT RUN |
| First ordinary chat replies on the computer that was running during the survey | NOT RUN | NOT RUN |
| A saved Memory fact remains visible after reload | NOT RUN | NOT RUN |

At 1280 px, the People page returned HTTP 503 with `membership_applying`, so
the Invite people button did not appear. The later People request for the 390 px
case returned 200 and the member joined. At 390 px, the bookmark loaded and the
welcome progress request returned HTTP 200. The browser driver could not read
the response body and stopped before it checked the final page.

The runner saved `up.log`, `browser.log`, `service-server.log` and the other
service logs before teardown. `down.sh --id 1` passed and slot 1 reported free.
[Run 1 browser checks](workspace-routing.json)

### Run 2

**PARTIAL on a fresh slot-1 Compose stack.** On 26 November 2026 the stack
started from `c16625816` with the free model stand-in. The test owner claimed
the installation through the bootstrap API. Both invitation links came from
the saved invitation commands. Chromium retained the entry response bodies
across navigation.

| Check | 1280 × 900 | 390 × 844 |
| --- | --- | --- |
| Signed-out survey request returns 401 | PASS | PASS |
| Member joins through a saved invitation link and opens the survey | PASS | PASS |
| Member saves the first answer while the personal computer runs | PASS | PASS |
| Signed-in unfinished member opens Conversations and returns to survey step two | [PASS](routing-run-2/workspace-unfinished-1280.png) | [PASS](routing-run-2/workspace-unfinished-390.png) |
| Reload of Conversations returns the unfinished member to survey step two | PARTIAL | [PASS](routing-run-2/workspace-unfinished-reload-390.png) |
| Member saves four survey answers, approves the persona and completes welcome | NOT RUN | PASS ([persona](routing-run-2/routing-persona-390.png), [welcome](routing-run-2/routing-welcome-390.png)) |
| Finished member keeps Conversations on a direct visit and reload | NOT RUN | [PASS](routing-run-2/workspace-finished-390.png) |
| First ordinary chat replies on the computer that was running during the survey | NOT RUN | [PASS](routing-run-2/routing-first-chat-390.png) |
| A saved Memory fact remains visible after reload | NOT RUN | [PASS](routing-run-2/routing-memory-390.png) |

The desktop driver stopped at the reload step before it could establish the
landing page. At 390 px, the computer and pod kept the same identity, start time
and restart count from the survey through the first chat. The runner saved
`up.log`, `browser.log` and the service logs before teardown. Slot 1 reported
free afterwards. [Initial browser checks](workspace-routing-run-2-initial.json)

The revised driver passed a local Chromium fixture at both widths. It interrupts
the initial Conversations entry request before reloading the real document. A
fresh live retry was **NOT RUN** because the host did not stay below load 6 for
five minutes in time to start the journey and leave time for teardown.

### Run 3

**PASS at 1280 × 900 and 390 × 844 on one fresh slot-1 Compose stack.** On
27 November 2026, the stack started from `1b7e277c5` with the free model
stand-in. The changes since run 2's `c16625816` were all receipt files, so
the 390 px result from run 2 covered the same product code. Both widths
passed again in run 3.

The test owner claimed the installation through the bootstrap API. The two
members joined through saved invitation links. To check a real browser reload
of `/workspace/conversations`, the revised driver interrupted the initial
entry request once to keep the browser on that document. The reload made its
own entry request and the browser then opened the saved survey step.

| Check | 1280 × 900 | 390 × 844 |
| --- | --- | --- |
| Signed-out survey request returns 401 | PASS | PASS |
| Invited member joins, saves the first survey answer and has a running personal computer | PASS | PASS |
| Direct visit to Conversations returns the unfinished member to survey step two | [PASS](routing-run-3/workspace-unfinished-1280.png) | [PASS](routing-run-3/workspace-unfinished-390.png) |
| Reload of Conversations returns the unfinished member to survey step two | [PASS](routing-run-3/workspace-unfinished-reload-1280.png) | [PASS](routing-run-3/workspace-unfinished-reload-390.png) |
| Reload of the survey keeps the saved step | PASS | PASS |
| Member saves all four answers, approves the persona and completes welcome | PASS ([persona](routing-run-3/routing-persona-1280.png), [welcome](routing-run-3/routing-welcome-1280.png)) | PASS ([persona](routing-run-3/routing-persona-390.png), [welcome](routing-run-3/routing-welcome-390.png)) |
| Finished member stays in Conversations after a direct visit, reload and fresh sign-in | [PASS](routing-run-3/workspace-finished-1280.png) | [PASS](routing-run-3/workspace-finished-390.png) |
| First ordinary chat replies on the computer that was running during the survey | [PASS](routing-run-3/routing-first-chat-1280.png) | [PASS](routing-run-3/routing-first-chat-390.png) |
| A saved Memory fact remains visible after reload | [PASS](routing-run-3/routing-memory-1280.png) | [PASS](routing-run-3/routing-memory-390.png) |

All 31 browser checks passed. Both members' computers and pods kept the same
identity, start time and restart count from the survey through the first chat.
Each member saw one saved fact after reload. The slot was claimed at 00:23 UTC
and reported free at 00:29 UTC after `down.sh --id 1` passed.
[Browser checks](workspace-routing-run-3.json)

### Previous routing attempt

On 26 November 2026, slot 1 started fresh from `40f775d3e` with the free
stand-in. The stack and website reported healthy. The test account signed in
through Zitadel. The stack had created an owner for a different account, so
the test account's welcome progress request returned HTTP 403. The browser
stopped before it could invite a member.

The driver saved `up.log`, `browser.log`, `service-server.log` and the other
service logs before running `down.sh --id 1`. Cleanup passed and slot 1
reported free.
