# Packaged onboarding and Memory

Journey on a fresh dev stack: PASS

On 26 November 2026, a fresh Helm install on slot 1 used commit
`6b980827f5afe912e193356ea407c833fd42398d`. The ownership check passed. Ordinary
chats used the free stand-in. The welcome ran from its saved script. The installer
logged the documented `OPENCRANE_ACCEPT_DEV_HOST_RISK=accepted-dev-box-366`
exception for swap and crash dumps.

The run used `claim.sh --id 1`, `run.sh package-prepare --id 1`, the package
preparation script, `run.sh package-up --id 1` and `run.sh package-check --id 1`.
The package forwarder connected the browser to the new installation.

| What passed | 1280 × 900 | 390 × 844 |
| --- | --- | --- |
| An invited member accepted the invitation and a sign-in from a workspace link opened the survey. | [Survey](survey-1280.png) | [Survey](survey-390.png) |
| The member saved one answer and signed in again from a workspace link. The survey reopened at the second step. | [Resumed survey](survey-resumed-1280.png) | [Resumed survey](survey-resumed-390.png) |
| The member saved all four answers and approved the persona. | [Persona](persona-1280.png) | [Persona](persona-390.png) |
| The member answered the welcome question and reached its completed state. | [Completed welcome](welcome-1280.png) | [Completed welcome](welcome-390.png) |
| A workspace link took the finished member to the workspace. The first ordinary chat used the computer that was already running during the survey and returned a reply. | [Before sending](before-chat-1280.png), [Completed chat](first-chat-1280.png) | [Before sending](before-chat-390.png), [Completed chat](first-chat-390.png) |
| The member saved a separate fact in Memory and saw it after reloading. | [Saved fact](memory-1280.png) | [Saved fact](memory-390.png) |
| A signed-out browser saw a sign-in prompt. The survey request returned 401. | [Sign-in prompt](signed-out-1280.png) | [Sign-in prompt](signed-out-390.png) |

The owner skipped setup and returned to the workspace from a sign-in link at both
widths. The browser checks recorded the computer and pod identity, start time
and restart count during the survey, before sending, and after the reply. All
matched for each member. [Browser checks](result.json)

Controlled time tests covered the hour limit, survey saves and the end of the
extra time when the member sends their first chat.

Kubernetes denied the file worker permission to create a pod or open an exec
session in the server pod. [Permission checks](worker-authorisation.json)

Two earlier attempts stopped in the browser driver. The first used the previous
provider dialog title. The second checked readiness while the computer was still
starting. Both attempts saved their logs before cleanup. The results above come
from one later fresh install. `run.sh package-down --id 1` and `down.sh --id 1`
both passed. Slot 1 reported free.

The next slice covers backup and restore for the survey, persona and Memory keys.
