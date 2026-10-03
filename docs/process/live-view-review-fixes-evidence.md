# P3-16 independent review fixes, blockers 1–4

This is the historical source receipt. Product chat mounting and fresh dev-stack
qualification are covered by [the conversation journey receipt](live-view-chat-evidence.md).

3 October 2026. Issue #57; source base `290ae4f`, branch `work/p3-16-liveview`.
Blocker 5 (product chat UI mounting) remains deferred until the chat UI lands.
This receipt covers the fixes, not completion of the full P3-16 capability.
Exact source hashes, check results and the live framebuffer/audit receipt are in
[review-fixes-receipt.json](live-view/review-fixes-receipt.json).

## Failing tests before fixes

| Finding | Reproduction and observed failure |
| --- | --- |
| Lifecycle audit scan | `wake.test.ts`: credential delivery stopped after a view audit; the continued-reconciliation assertion timed out. |
| Automatic pongs | `live-view.test.ts`: 256 full-size pings left both reading and paused viewers open; neither stop audit appeared. |
| Deployed Kubernetes identity | `live-view-k3d.test.ts`: the desktop stream disconnected before its RFB greeting with a token for the deployed `computer-lifecycle` service account. |
| Frontend routing | `live-view-proxy.test.ts`: both configured Angular proxies returned 404 for the viewer socket under `/ws`. |

Each regression was run before its corresponding implementation change.
The lifecycle test now covers all three view events, continuing credential
delivery and a suspension after a new worker replays the same NATS history.
The ping tests cover abusive reading and paused clients, a healthy neighbour,
and one ping when a corked TCP output queue is near 4 MiB. The last case checks
the byte bound independently of the ping rate limit, including the close frame.

The Kubernetes tests install the tracked Role and mint a short-lived token in
fresh namespaces. Every desktop connection uses that service-account kubeconfig;
the host identity only creates and cleans up fixtures. The tests decode 480,000
pixels, reject a non-computer label and check cross-namespace and unrelated
permissions are refused. Kubernetes RBAC cannot select labels or name prefixes
for dynamically named Pods; the adapter checks the label, name and recorded UID.

Both frontend tests start a real Angular dev server, preserving the configured
proxy routes and changing only backend ports. The dev-stack config is generated
in a disposable directory. Both exercise admission, RFB bytes, start/stop audits
and the existing `/ws` hello exchange.

## Admission compatibility found during qualification

The additional lifecycle journey failed before its first Ready event. Kubernetes
reported `SandboxPodCreateFailed`: the Pod admission policy still required one
environment variable, while P3-16's checked template adds `POD_UID` to `GATEWAY`.
A focused dry-run test then failed because the policy rejected that checked
Pod template. The rule now permits exactly those two variables and requires
`POD_UID` to come from `metadata.uid`. The regression also rejects a forged
identity field. The shared namespace and its policies were never changed.

## Verification

Tests use `PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`.
Live runs use existing `k3d-ocn`, real gVisor and the tracked image, with fresh
`p316-view-*` and `p22-*` namespaces. They are source qualification, not a fresh
silo install. No shared dev-stack services or settings are used or changed. All disposable
namespaces and their admission policies were confirmed deleted afterwards.

| Command or journey | Result |
| --- | --- |
| `npm run lint` | PASS; six existing function-length warnings |
| `npm run typecheck` | PASS; all workspaces |
| `npm run check:events` | PASS; 76 event types agree |
| `PG_TEST_URL=… npm test -- --maxWorkers=2` | PASS; 65 files, 1,038 tests; 13 gated tests skipped; 483.25 seconds |
| `npm run build -w apps/web` | PASS; existing CSS budget warning |
| `npm run test -w apps/web -- --watch=false` | PASS; 43 tests |
| `npm run build:live-view-test -w apps/web` | PASS; existing noVNC CommonJS warning |
| `LIVE_VIEW_K3D=1 PG_TEST_URL=… npx vitest run apps/server/test/live-view-k3d.test.ts --maxWorkers=1` | PASS; two tests, 108.84 seconds |
| `LIFECYCLE_K3D=1 PG_TEST_URL=… npx vitest run apps/ops/test/lifecycle-k3d.test.ts -t 'admits the checked\|qualifies the event-driven' --maxWorkers=1` | PASS; two selected tests, 130.55 seconds; seven unrelated repair cases skipped |

The first repository run failed during gateway process startup in the pinned-model
test; that test passed in isolation. The complete final run above passed with implementation edits settled. Initial lifecycle runs and the focused admission test failed on
the environment-variable mismatch described above.

Product chat mounting, real OIDC sign-in, the fresh-silo Phase 3 journey and
hosted CI remain **NOT RUN**. No branch was pushed and no further independent
review pass was requested or performed in this repair round.
