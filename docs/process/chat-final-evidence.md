# P2-5 final qualification

Date: 3 October 2026. Branch `work/chat-ui`; source is the commit containing
this receipt, based on rebased `e54b3e7` and `origin/main` `5ca26b6` (#65),
which includes wake-latency change `e727898` (#64).
Environment: `ocn-dev`, Linux, Node 22.23.3, Playwright Chromium, k3d gVisor.
The rebase retained both the wake-latency bookkeeping and durable Stop filtering.
Main advanced during qualification; the final rebase also retained both the new
Odoo fixture lint command and the chat scripts. A tree comparison confirms that
all application, library, dev-stack and script source, plus the lockfile, are
unchanged from the source qualified below. Lint was rerun on the final base to
include the new fixture boundary check; the other passing checks were not repeated.
The computer image remains pinned to
`sha256:b2a2852e085fe852a61125f48258630ac284ab1090e35fcf235e9eed9b8a3994`.

## Changes and focused proof

- File swatches follow the owner default on #30: PDF red `#c1392b`, DOCX
  blue `#2a5c9a`, XLSX green `#2a7d4f`, other types grey `#81888a`.
  [Visual item 33](../design/chat/visual-fix-list.md) is resolved. Computed
  colours passed in both the transcript and Files panel at 1280px and 390px.
- The [comparison frames](../design/chat/comparison/index.html) were regenerated
  with Alex Morgan. The app reads the signed-in profile name from `/auth/me`,
  with “You” for an absent name. The name is display data, never authorisation.
  The HTTP login test first failed for the missing profile name; the browser
  first showed the member projection's different fixture name. Both now pass.
  Real browser qualification checks the displayed name against `/auth/me`.
- Live Stop exposed a 409 append conflict with streamed reports. The browser
  regression first timed out waiting for Stopped after a forced conflict;
  it now passes. Commands retry a 409 at most twice with the same id.
  Offline and authorisation failures keep their existing behaviour.
- The live harness now follows the reviewed Draft/SVG controls, chooses the
  composer's Stop button, activates each browser page and waits for finite
  animations before screenshots. Failure screenshots stay in the private stack
  directory. No third independent review was run after the supplied pass-two approval.

## Gates

PostgreSQL tests used
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`.

| Command | Result | Seconds | Evidence |
| --- | --- | --- | --- |
| `npm ci` | PASS | 16.89 | Clean install |
| `npm run lint` | PASS | 87.34 | All six checks on the final base; five existing size warnings |
| `npm run typecheck` | PASS | 111.61 | Every workspace |
| `npm run check:events` | PASS | 0.67 | 74 event types agree |
| `PG_TEST_URL=… npm test -- --maxWorkers=2` | PASS | 444.90 | 65 files / 1,028 passed; 2 files / 10 opt-in tests skipped |
| `npm run build -w apps/web` | PASS | 10.91 | Passes error budgets; bundle/CSS size warnings remain |
| `NO_COLOR=1 npm run test -w apps/web -- --watch=false` | PASS | 16.47 | 6 files / 43 tests |
| `npx tsc -p infra/dev-stack/tsconfig.json` | PASS | 18.02 | Final journey harness |

The final root suite includes Chromium interaction and production-CSP tests.
`npm run visual:chat` also passed (92.51s), regenerating all 40 built frames.
The later Stop-conflict regression passed without changing the visual fixtures'
rendered content. Local command logs are in `/tmp/chat-final-evidence/`.

## Live stack

Only the loopback scripted model provider at `127.0.0.1:43003` was used.
No real OpenAI calls or credentials were used. Zitadel access stayed within
organisation `393311211338337681`; no management configuration was changed.
The public entrypoint is tailnet HTTPS; the stack's listener/firewall check passed.

[Sanitised journey output](chat-final-stack-evidence.txt) records the checks.
The shared owner marker was transferred only after stopping its original stack.
After qualification, worktree `down.sh` passed (13.62s), the marker was restored
to `/home/jente/dev/opencrane-new`, and that checkout's `up.sh --fresh` passed.
The original checkout had independently advanced to `5ca26b6` (#65); its working
tree is clean and its stack is left running. A final verified HTTPS GET of
`https://ocn-dev.tail00285e.ts.net/` returned **200** with the app root present.

| Journey | Result | Total seconds | Wake to first token | Wake to completed reply |
| --- | --- | --- | --- | --- |
| Worktree `up.sh --fresh` | PASS | 235.38 | 15.678s | 17.645s |
| Worktree plain `up.sh` | PASS | 193.63 | 17.313s | 18.908s |
| Original checkout `up.sh --fresh` | PASS | 197.52 | Not measured by its harness | 9.437s |

Fresh browser timings (send to first rendered token / completed reply):
390px **3.415s / 5.081s**; 1280px **1.860s / 3.559s**.
Retained-state browser timings: 390px **3.906s / 5.593s**; 1280px
**3.398s / 5.174s**. The committed captures are from this retained-state run.
Wake timing starts before posting to a suspended computer and ends at the first
matching delta observed on its real WebSocket, sampled every 50ms. These are
dev-stack measurements, not the isolated #64 benchmark or a latency guarantee.

Both widths use real Zitadel sign-in, open the workspace, send through the
composer, observe streaming, reload the completed reply, stop a second turn
mid-stream and reload its unchanged partial text. The full journey also checks
reconnect without duplicates, suspend/resume, disk after Pod replacement,
projection replay, access refusals and logout/token boundaries.

Live captures: [1280px](../design/chat/live/workspace-1280.png) and
[390px](../design/chat/live/workspace-390.png). These show the dev account's
actual profile name, separately from the Alex Morgan comparison fixtures.

### Earlier failed attempts

The unrestricted root suite hit five-second integration timeouts under concurrent
load and was stopped; the final complete two-worker run passed without increasing
test timeouts. Early stack attempts failed on SSO handoff/return timeouts, occupied
web-port/model-gateway startup, obsolete journey selectors, and a composer timeout.
A direct live run then exposed the Stop conflict fixed above. One initial wrapper
was terminated without a receipt. These attempts are not counted as passes;
the successful command receipts determine the final journey results. Restoration
also needed retries after sign-in, model-gateway readiness and token-probe sign-in
failures; no original-checkout source was changed to obtain the final PASS.

## Limits

PARTIAL: file cards/preview UI exist; live file-byte transport, upload and Office
conversion remain outside this qualification.

NOT RUN: real OpenAI; the owner's manual sign-in and visual approval; real phone
hardware/software keyboard; Firefox/WebKit; production installation; hosted CI,
PR creation, push, merge and post-merge main gates; a further independent review.
The ten skipped opt-in tests are eight standalone k3d lifecycle/recovery cases,
one standalone k3d bridge case and one real-provider case. The dev-stack journey
separately qualifies its lifecycle/bridge path with the stub; it does not replace
all standalone deletion/recovery cases. No computer image rebuild was needed.
