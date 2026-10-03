# P3-1 final live qualification

3 October 2026, `work/p3-1-policy`. The review-approved `49e5200` rebased
first onto `5ca26b6`. Main advanced during qualification; the final rebase
onto `ed21e0b` resolved four conflicts by retaining both chat and policy UI, CSS,
protocol exports and documentation. Final source: `b63234c` plus the journey
ordering and login harness adjustments in this receipt's commit.
Linux x86-64, Node 22.23.3, local Compose services and k3d `ocn` gVisor computers.
The shared stack was stopped from `/home/jente/dev/opencrane-new` before its
ownership marker was transferred to `/home/jente/dev/wt/p3-1-policy`.
`npm ci` passed in this worktree before startup. Qualification added no
application changes or dependencies. The newly merged browser chat probe was moved after the existing model-grant wait; fresh and repeat journeys
check those grants before either browser or HTTP chat begins.

## Journeys

| Journey | Result | Evidence |
| --- | --- | --- |
| `infra/dev-stack/up.sh --fresh` | PASS | [Core journey](fresh-stack.txt); stub chat 4,267ms, wake-and-chat 17,940ms |
| Fresh policy qualification | PASS | [Assertions](fresh.txt), [1280px](fresh-1280.png), [390px](fresh-390.png) |
| Plain `infra/dev-stack/up.sh` | PASS | [Core journey](repeat-stack.txt); stub chat 6,273ms, wake-and-chat 18,739ms |
| Repeat policy qualification | PASS | [Assertions](repeat.txt), [1280px](repeat-1280.png), [390px](repeat-390.png) |
| Restore owner checkout with `up.sh --fresh` | PASS | [Core journey](restored-stack.txt), owner checkout `ed21e0b`; HTTPS 200 |

Both startup commands invoke the actual grant migration CLI before decision
startup. The extra policy probe invokes that CLI twice against the populated
stack and compares all model-grant event IDs before/after; both runs retained
all 66 IDs. The core journey separately requires grant history for existing
members/assistants and live OpenFGA grants for newly joined members/assistants.

The policy probe signs in through real Zitadel, seeds a reviewed, credential-free
MCP fixture through events, and saves Allow then Block through the actual admin
screen and API. At 1280px and 390px it checks the saved Block selection, HTTP 200,
no horizontal overflow and controls at least 44px high, then captures screenshots.
No API response or browser page is mocked.

The probe uses current computer/turn credentials, event-backed conversation and
requester/assistant grants, and waits for OpenFGA event receipts. A temporary
pinned agentgateway routes the fixture call through the stack's running decision
service. `tools/call` returns **403**, specifically **policy_block**, with a durable
`decision.recorded` deny event and **zero** calls at a recording MCP upstream.
The temporary gateway is restricted to loopback by IPv4/IPv6 firewall rules;
its processes and rules are removed after the probe. The model route stays on
the local SSE stub with a disposable key; no real OpenAI call is made.

Before the final rebase, the [first plain-start attempt](repeat-attempt1.txt)
failed at Zitadel's provider-input step. A separate fresh browser reached the normal provider login form; no application change or
timeout relaxation was made before retrying. This failed attempt is not a pass.
The ad hoc screenshot probe also needed its label selector corrected to account
for the controls' glyphs before the successful qualification.

After the second rebase, a fresh run reproduced an empty provider username field
and disabled Continue button after filling. The login harness now retries once
only when that visible field has been cleared. Other errors still fail. The
Chromium regression in `apps/server/test/provider-login.test.ts` clears the first
fill and proves that Continue receives the second fill. It failed before the fix
and passed afterwards (9.67s). The later aggregate suite includes this regression.
An intermediate owner restart also failed because Angular found port 44200 in
use; the listener had gone before inspection. Another fresh attempt found NATS
port 44222 occupied; that listener also disappeared before inspection. The stack
was stopped before the next ownership transfer. Only completed final runs listed here qualify the result.

The ownership marker is restored to `/home/jente/dev/opencrane-new`. The server,
web and model process working directories point there. Its unmodified `ed21e0b`
startup passed the full fresh journey, all [service checks](restored-status.txt)
passed, and the stack answers at
<https://ocn-dev.tail00285e.ts.net/>. No push, PR or merge was performed.

The first aggregate run had 1,041 passing tests and one gateway-startup failure.
The shell's restrictive `umask 077`, used to protect captured output, also made
the credentials fixture's bind-mounted configuration unreadable to its container.
The failure reproduced in isolation; retained container diagnostics reported
`/config.yaml: Permission denied`. Restoring the normal subprocess umask while
keeping the output file at mode 0600 fixed this runner setup; the unchanged
focused credentials test passed in 6.11s. No credentials
assertion or deadline was changed. The final aggregate result follows.

## Local gates

| Command | Result |
| --- | --- |
| `npm ci` | PASS, clean install after the final rebase |
| `npm run lint` | PASS, existing warnings only; final documentation and links rechecked |
| `npm run typecheck` | PASS, all workspaces including the login regression |
| `npm run check:events` | PASS, 75 event types |
| `PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres npm test -- --maxWorkers=2` | PASS, 66 files / 1,042 tests; 2 files / 10 tests skipped; 485.34s ([output](tests.txt)) |
| `npm run build -w apps/web` | PASS, existing CSS size warnings |
| `npm run test -w apps/web -- --watch=false` | PASS, 7 files / 45 tests |
| `npx tsc -p infra/dev-stack/tsconfig.json` | PASS |

## Not run

Real OpenAI/paid-provider calls, real Odoo and credential release, MCP transport
from inside gVisor computers, approval creation/consumption, owner-device
interaction, hosted CI, Helm/HA and
managed-cluster qualification: **NOT RUN**. The root suite's nine opt-in
live-cluster cases and one paid-provider case remain skipped. The requested
live dev-stack lifecycle journey passed separately. This receipt
qualifies the reviewed fixture and the requested Phase 2 regression journey;
it does not claim completion of the remaining Phase 3 tickets.

All real Zitadel identities used here belong to organisation
`393311211338337681`. The existing wrong-org refusal probe changes only a local
server's expected org pin; it does not access another organisation. HTTPS access
uses Tailscale Serve, with no Funnel or public application listener.
