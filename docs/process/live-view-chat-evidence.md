# P3-16 conversation viewer and secondary-stack journey

3 October 2026. Issue #57, review pass 1 blocker 5. Continued the interrupted
uncommitted work and rebased onto `origin/main` at `cc8d8c0` (chat UI #66, tool
policy #68 and parallel journeys #69). The replayed review-fix base is `7e65b3e`.
No new dependency is added. [Source hashes](live-view/chat-source.json) bind the
working-tree overlay to the [gate summary](live-view/chat-checks.txt).

## Outcome and test boundaries

The real chat workspace's desktop session panel and 390px session overlay offer
**Watch your computer** for a saved conversation. A native dialog restores focus
on Escape. A participant without an explicit shared-desktop member grant sees
**Not available** with an explanation. The granted viewer is read-only; revocation
closes its connection and clears pixels while explaining **Access changed**.
Conversation changes cancel pending admission and close the old view. Viewer
buttons are at least 44px in each dimension.

The user specified the tested boundaries: rendered conversation controls,
authenticated viewer admission/revocation and the signed-in browser journey
through the configured frontend proxy. The interrupted session's first Chromium
regression failed on the missing entry before implementation, then passed at both
widths. Angular regressions retain refused access and pending admission
cancellation. jsdom's missing dialog methods are replaced only in the unit fixture;
Chromium exercises the native keyboard and focus behaviour.

After #68, the API regression reproduced a granted participant receiving 403.
The viewer now uses `grantStream('shared_desktop', computerId)` and the existing
resource `use` tuple. Its event-history check still requires an explicit member
grant, independently of participation, so inherited team or assistant access
cannot admit a viewer. Both grant and revoke events share one resource stream.

The interrupted journey also exposed two timing regressions. The authority budget
was shorter than OpenFGA's bounded one-second call plus event reads; the delayed
API regression failed with 403 before allowing 1200ms. The desktop lease remains
1500ms. A delayed positive reply originally extended the lease from its completion
time and revocation took 2175ms. Renewal now starts when the check starts, retaining
the two-second revocation bound. These regressions use real authority data with
delayed external replies.

## Environment and live evidence

Secondary stack **1**, loopback browser origin `http://127.0.0.1:25106`, namespace
`opencrane-dev-1`, Node 22.23.3, existing k3d `ocn`, real gVisor, NATS, PostgreSQL,
OpenFGA, MinIO and Zitadel organisation `393311211338337681`. Only the secondary
claim and its resources are managed; the owner stack and ownership marker are
untouched. The computer image, observed through the deployed service account, is
`k3d-ocn-registry:5000/opencrane/computer@sha256:b2a2852e085fe852a61125f48258630ac284ab1090e35fcf235e9eed9b8a3994`.
The model gateway uses the stub. No real OpenAI call is made and no OpenAI credential is used. No Tailscale Serve or Funnel change is made.

Browser requests use the generated Angular `/api` and `/ws` proxies, deployed
server and namespace-scoped `computer-lifecycle` service account. The viewer opens
from a conversation created through the real composer after real OIDC sign-in.
No alternate viewer host, test Fastify connection or minted browser session is
used for this viewer journey. The fixture uses #69's namespace selection throughout.

At each width the browser first refuses a participant without a grant. A dev-only
grant event then permits a non-uniform 800×600 framebuffer. The journey checks
keyboard opening, Escape, fit/actual-size and 44px targets, and completes a real
Codex turn through the stub while viewing. A known window is fixture desktop
activity. Revocation must remove the canvas within two seconds and record
`computer.view_stopped` with `access_changed` and the admitted session id.
No business state is written directly to PostgreSQL.

Fresh receipts: [1280px](live-view/fresh-conversation-1280.json) and
[390px](live-view/fresh-conversation-390.json). [1280px](live-view/conversation-1280.json) and
[390px](live-view/conversation-390.json) record the latest run. Screenshots:
[desktop](live-view/conversation-viewer-1280.png),
[phone](live-view/conversation-viewer-390.png),
[desktop entry](live-view/conversation-entry-1280.png),
[phone overlay](live-view/conversation-entry-390.png),
[desktop revocation](live-view/conversation-revoked-1280.png) and
[phone revocation](live-view/conversation-revoked-390.png).

The final fresh browser receipts are dated 22:32 UTC and the retained-state
receipts 22:36–22:37 UTC. Revocation cleared pixels in 341ms / 334ms (1280px / 390px)
on fresh startup and 430ms / 412ms on plain startup. Both complete startup commands exited successfully, and secondary teardown
passed at 22:40:34 UTC.

## Verification

| Command or journey | Result |
| --- | --- |
| Worktree `npm ci` | PASS |
| `npm run lint` | PASS; seven function-length warnings |
| `npm run typecheck` | PASS; all workspaces |
| `npm run check:events` | PASS; 78 event types agree |
| Earlier no-retry `PG_TEST_URL=… npm test` | FAIL; 1061 passed, 13 skipped, one gateway budget case failed with zero admissions |
| Final full suite with `--retry=1` | PASS; 68 files, 1063 tests passed; 13 tests skipped; one gateway case retried; 1078.30s |
| `npm run build -w apps/web` | PASS; bundle/CSS budgets and noVNC CommonJS warnings |
| `npm run test -w apps/web -- --watch=false` | PASS; eight files, 47 tests |
| `npx tsc -p infra/dev-stack/tsconfig.json` | PASS |
| Secondary `infra/dev-stack/up.sh --fresh` | PASS on the final source; both viewer widths |
| Secondary plain `infra/dev-stack/up.sh` | PASS on the final source; both viewer widths |
| `infra/dev-stack/down.sh --id 1` | PASS at 22:40:34 UTC; [teardown receipt](live-view/stack-down.txt) |
| Independent review pass 2 | PASS before the final authority corrections; owner assessment remains before landing |

Repository tests use
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`. The optional
paid-provider and additional Kubernetes qualifications remain skipped in the
root suite; this journey independently qualifies the deployed desktop path.
Earlier attempts failed on startup timeouts or a viewer that closed before the
explicit revoke. A full-suite rerun under heavy shared-host load failed the
unchanged gateway tool-mode case and was interrupted. A later
no-retry run passed 1061 tests and skipped 13, but failed one unchanged gateway
budget case with zero admissions. Both daily/monthly budget cases then passed
in isolation (17.09s). The final complete run passed 1063 tests and skipped 13 in 1078.30s with one
bounded retry. The unchanged gateway reviewed-tool-modes case used that retry;
no assertion or runtime authority deadline is relaxed. Its command was
`MODELS_REAL_CALL=0 PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres npm test -- --no-file-parallelism --testTimeout=15000 --retry=1 --reporter=verbose`. Several repeat attempts also failed on an interrupted assistant reply before
streaming, including one after desktop viewing had opened. Machine-only diagnostics
showed allowed model decisions without a matching HTTP error code; no root cause
is claimed for those intermittent reply failures. All failed stacks were torn down.
A temporary non-pausing
logpoint on this worktree's server showed positive checks taking 457–674ms. The
single-check guard skipped the next 500ms tick; one positive reply arrived 197ms
after the previous snapshot expired. This was a scheduling defect, not a missing
grant. CPU counters did not justify increasing the NATS or OpenFGA limits.

The API regression now opens a granted stream through real authority data with
slow external replies and verifies it stays open for 3.5 seconds and still
forwards desktop bytes. It failed with WebSocket CLOSED before the fix. At most
five bounded checks can now overlap, including the check after the start audit.
A later reply from an older check cannot shorten a fresher lease. A second live
trace showed an allowed reply taking 1165ms: a 500ms start interval still left a
gap before its successor arrived. The stronger regression retains 400ms of event
read delay plus a 650ms authority reply throughout the open stream. It failed
with CLOSED before shortening the start interval to 250ms, then passed; the
delayed-reply revocation regression also passed. The 1500ms lease, 1200ms check
deadline and two-second revoke assertion are unchanged. Healthy views now make
four authority checks per second rather than two, with at most five outstanding.
The trace also showed most time spent replaying conversation and computer history;
the permission reply itself took about 24ms. A further API regression warmed a
computer history, delayed each historical event read by 100ms, and reproduced a
second authorised admission returning 403. Viewer authority reads now retain up
to 64 checked histories per event-store connection and read each live tail from
its last sequence on every check. Every read confirms the saved checkpoint’s sequence and event id before
reading its tail. Missing or replaced checkpoints clear the cache and refuse
access; read failure also refuses access. A public API regression reproduced
200 when a previously checked computer history vanished; it then passed with
403 after adding the continuity guard. No cached snapshot replaces a current
source read. Silo keys remain separate, and older
concurrent replies cannot move a checkpoint backwards. The new grant revoke is
still refused by the event history before its projection catches up. All eleven viewer API tests passed after the continuity guard (59.03s, one
retry permitted), and again in the final full suite without needing a retry. The capacity test’s connection helper also resolves early
socket closure, so allowed refusals finish and release their fixture instead of
hanging. Its capacity audit and upper bound remain asserted. A compact event projection would be
needed if retained histories became large.
Temporary debugger processes were stopped before final gates. A passive native
notification observer records only fixed error categories and numeric status
codes during repeat-start diagnosis; it sends no commands and stops at teardown.
No debugger is needed to run the journey.

Repeat qualification exposed three fixture defects. Plain startup left the
secondary model container running during migration; it now stops and restarts
that container. The stub paused when an old Stop prompt appeared anywhere in
conversation history; it now matches only the latest user input. A focused HTTP
check with an old Stop prompt and a later viewer prompt completed within five
seconds; the browser still checks current-prompt Stop. Finally, legitimate
uncertain reservations left by Stop exhausted the 2000-cent daily fixture cap.
Fresh secondary stacks now seed a 100000-cent daily/monthly ceiling through one
conditional event append before the model actor starts. Repeat runs preserve
the ledger and reservations. These limits apply only to stub journeys. Secondary
readiness also allows a bounded two-minute startup on the shared host.

Independent pass 2 read the full diff and working-tree journey source, including
fixes 1–4, chat mounting, grant-model compatibility and lease renewal. It found no
blocking source defect. The secondary startup, model restart, stub prompt, fixture budget and final
renewal scheduling, tail-read and continuity corrections followed the review. The final source checks and
fresh/repeat journeys qualify them. Pass 2 predates the final scheduling, tail-read and continuity corrections; the
owner must assess those changes before landing. No third independent
pass is requested.

Hosted CI is NOT RUN; this branch is not pushed. Managed-cluster TLS/HA, takeover,
control, clipboard and the wider Phase 3 qualification are outside this journey.
