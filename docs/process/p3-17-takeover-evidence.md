# P3-17 requester desktop takeover

Issue [#58](https://github.com/elewa-git/opencrane-new/issues/58), parent
[#41](https://github.com/elewa-git/opencrane-new/issues/41), D22. Source base:
`bbf0bab` (viewer #73), branch `work/p3-17-takeover`, 4 October 2026.

## Why and functional outcome

The requester can help their assistant with a login on its shared desktop.
Take control records intent before fencing every conversation on that computer;
all active Codex turns and UID 1001 tools must stop before one writer is admitted.
Participants/admins without current requester status cannot take control. Viewers
keep the existing read-only RFB allowlist. Control adds only keyboard and pointer
input, translates standard pointer messages for Kasm, and refuses clipboard.

Leases last at most two minutes and require authorised renewal. Disconnect,
expiry, revocation and crash close writer access and leave work paused. Reconnect
cannot recreate a writer. Release closes tunnels first and records its caller. Its committed reaction
checks local quiescence and resumes only authorised checked work with fresh turns and
tokens. A changed requester can explicitly release the closed same-conversation
lease. Missing terminal reports close as failed; external effects remain observed
or uncertain, and approvals/writes are never silently replayed.

## Architecture and recovery

`takeover.requested/started/renewed/failed/ended` share a computer stream and carry
requester, computer generation/Pod, conversation, lease and affected turns.
Conditional appends fence racing admissions. Pauses react only to committed
takeover events; rejected requests have no execution effect. The bridge orders
pause and resume by committed computer-stream version, retaining release
checkpoints across restart. Common gateway credentials reject
paused work and permanently reject turns predating the last intent after release.
Startup recovers abandoned transitions through trusted Pod pause, records crash,
and retries unavailable pause without admitting a writer. Paused lifecycle
reconciliation still refreshes private control credentials and observes Pod loss.

The bridge persists a pause marker before interrupting threads. The supervisor
refuses new executor connections and repeatedly stops/checks all UID 1001
processes. Its fixed helper runs as that UID, requiring no new capability. The
model proxy clears grants and fences dispatch; an already dispatched external
request keeps its existing observation/uncertainty path. All three components
read the marker at boot. Release reactions are idempotent and create a new
message asking the assistant to inspect the desktop and retain unknown outcomes.

## Evidence

The table below records the original implementation. The subsequent independent
review pass 1 found execution ordering and keyboard escape blockers. Their
reproductions, fixes and current check results are recorded in the
[review-fix receipt](p3-17-review-fixes-evidence.md). Review pass 2 for these
fixes is LAND at `93c80ee`, as confirmed by the owner. The
[secondary-stack receipt](p3-17-live-evidence.md) records the rebased qualification.

TDD started with failing requester/pause, bridge and browser journeys. The live
probe exposed root's missing CAP_KILL; the same-UID helper fixed it. Fault tests
also exposed delayed stream destruction without an error listener. Live computer
restarts exposed a stale Xvnc socket/lock; the sole-server launcher now removes
these before restarting. Gateway replay tests now await the complete receipts
they intend to replay before killing the gateway. Recovery tests cover physical pause after a crash, expired private credentials
and changed-requester recovery. Different-model review found a released computer
could stall after later suspension; the wake regression checks a recreated Pod
and a fresh checked turn token.

| Qualification | Result |
| --- | --- |
| Required lint, typecheck, event catalogue, root suite | PASS; 73 root test files, 1,223 passed / 16 opt-in skipped, 785 seconds |
| Web production build and web tests | PASS; 56 tests |
| API/WS: requester, one writer, renewal, readonly viewers, delayed connection | PASS |
| Intent/start/renew/end append failures; crash at intent/start/renew | PASS |
| Expiry, disconnect, revocation and changed-requester recovery | PASS |
| Short-TTL refresh; old tokens denied; missing reports and idempotent release | PASS |
| Real gVisor: two Codex conversations, running UID 1001 tool, pause/control/release | PASS; final combined rerun, two live tests in 221 seconds |
| Playwright 1280/390px: keyboard Take/Release, input, 44px targets, no overflow | PASS; both widths on the final computer image |
| Image source and routing match checkout; root ownership and no build/runtime secrets | PASS |
| Independent review | Different-model pass 1 BLOCKED; wake fix verified, final pass 2 PASS |
| Fresh complete silo / paid provider / secondary stack | NOT RUN |

The root suite skips opt-in Kubernetes journeys; both takeover live tests ran
separately and passed. Final lint, typecheck and the 85-event catalogue passed.

The live test creates a disposable namespace on `k3d-ocn`, confirms
`io.containerd.runsc.v1`, and always deletes the namespace. It uses real Codex,
bridge, lifecycle admissions, private computer control and Kasm. Responses and
identity issuance use isolated fixtures; no paid upstream or owner stack is used.
The browser test serves the built LiveView host on the real server/proxy and uses
a pause adapter without active threads; the separate runtime journey proves
whole-computer quiescence. Screenshots are generated under
`apps/computer/.state/p317/control-{1280,390}.png`.

Original candidate image: `opencrane/computer@sha256:5cfe0d46972df36f2a2b3d2a6b09b78c10944ba8f6233b687a9501ed1dc58e1c`.
A source-only overlay of reviewed base `b2a2852e085fe852a61125f48258630ac284ab1090e35fcf235e9eed9b8a3994`
adds no application dependencies or OS packages. The original runtime manifest pinned this
candidate. The [secondary-stack receipt](p3-17-live-evidence.md) records the
reviewed source-fix image now pinned by the template. Existing OSI/DFSG licence
reviews apply unchanged.

```sh
PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres npm test -- --maxWorkers=2 --testTimeout=30000
npm run lint
npm run typecheck
npm run check:events
npm run build -w apps/web
npm run test -w apps/web -- --watch=false
npm run build:live-view-test -w apps/web
TAKEOVER_K3D=1 PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres npx vitest run apps/server/test/takeover-k3d.test.ts --maxWorkers=2
```

## Not in this change

Screenshot persistence (P3-18), new gateways, desktop Services, clipboard,
automatic external-write retries, production rollout and fresh full-silo
qualification. Source readiness and disposable live-computer evidence do not
claim a fresh complete silo journey.
