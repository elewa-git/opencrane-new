# Packaged onboarding and Memory

Journey on a fresh dev stack: PASS

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
