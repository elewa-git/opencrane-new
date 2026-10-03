# P3-16 authenticated desktop view

Issue #57, parent #41, D22. Source base: `e727898` (3 October 2026).

## Architecture

The self-contained conversation viewer requests a one-use, 15-second ticket with its session
cookie, exact Origin and `x-opencrane-view: 1` header. The WebSocket presents
that ticket as a subprotocol, bound to the same cookie and conversation.
Admission uses `POST /api/conversations/:id/view`; the socket uses
`/ws/conversations/:id/view`, through the frontend’s existing `/ws` proxy.
Tickets are never URL parameters. The server derives the computer from event
history; callers cannot choose a computer address, credential or generation.

Both current conversation participation and an explicit `shared_desktop` member
grant are required. OpenFGA checks use higher consistency. Event history also
checks revocations, closure and the current Ready generation, so delayed
projection work cannot keep a revoked view alive. Checks run every 500 ms with
an 800 ms deadline. Authority, generation and expiry are checked again after
the start-audit append, before opening the desktop. A stale check closes the stream. Views expire with the cookie
or after two minutes, whichever comes first.

The server's Kubernetes identity checks the recorded Pod UID, then opens a
private `pods/exec` stream into that Pod. A fixed helper drops to UID 1002 and
connects to loopback Kasm as `viewer`. The ephemeral Kasm password stays inside
the Pod. There is no Kasm Service, port-forward or browser credential. The
computer NetworkPolicy admits no Kasm ingress, including from server-labelled
Pods. The namespace-scoped server role requires Pod `get`/`list` and
`pods/exec` `create`. Pod names are assigned dynamically and Kubernetes RBAC
cannot select labels or name prefixes, so this Role cannot restrict these
permissions to computer Pods. The adapter lists `app=computer` Pods and checks
the name, UID and label before exec. The existing lifecycle role is trusted; this does not grant desktop callers
Kubernetes credentials.

The proxy promotes S0.5's complete-message RFB allowlist across WebSocket
fragmentation and coalescing. It permits only the shared RFB 3.8/None handshake
and display requests, forces raw encoding, and rejects input, clipboard, file
transfer, unknown messages, excessive encoding counts and messages above 4 KiB.
Both sending directions are bounded to 4 MiB. Outgoing accounting includes
data and manual pongs, with 127 bytes reserved for an automatic close frame.
A viewer sending more than 16 pings in one second closes with 1013; automatic
pongs are disabled. Admission is capped at 16 opening or active views and 1,024 short-lived tickets. A slow viewer closes independently.
Kasm's read-only account remains a second check.

Each session has a `view-<sessionId>` stream. Start is conditionally appended
before connecting; stop records its reason with the same person, conversation,
computer and generation. Refusals use separate `view-<attemptId>` subjects.
The lifecycle worker selects only lifecycle event types, including when
replaying history after restart. Replay opens no connection. Start records the expiry:
a process crash can leave a start without a stop, and an unavailable event store
can prevent stop persistence. Those are incomplete audit trails, never claimed
as successful stop events; the socket still closes and safe metadata is logged.

## Browser licence

Only `@novnc/novnc@1.5.0/lib/rfb.js` and its core imports enter the viewer bundle.
Reviewed the installed `LICENSE.txt`, core notices and bundled pako notices:
MPL-2.0, BSD-style licences and MIT, all OSI-approved. MPL-2.0 is listed as [approved by the OSI](https://opensource.org/license/MPL-2.0). The lockfile pins integrity.
No stock noVNC or Kasm HTML, CSS, fonts or artwork is imported. Angular emits the
third-party licence notices with its production build. The upstream
[licence inventory](https://github.com/novnc/noVNC/blob/v1.5.0/LICENSE.txt) describes
these divisions. The pinned unmodified core source is available from the upstream v1.5.0 tag
linked above; its MPL notices are retained.

## Qualification

Receipt: 3 October 2026, Node 22.23.3, source base plus the exact source hashes in
[receipt.json](live-view/receipt.json). Live tests use fresh `p316-view-*`
namespaces on existing `k3d-ocn`, the tracked computer image, real gVisor,
disposable OpenFGA and NATS, and isolated databases on
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`.
The shared dev stack was not used or modified. All test namespaces were deleted;
no PVCs were created. This is source qualification, not a fresh silo install.

| Check | Result |
| --- | --- |
| Clean `npm ci` in a temporary directory with copied workspace manifests and lockfile | PASS; temporary dependency tree deleted |
| `npm run lint` | PASS; six function-length warnings, no errors |
| `npm run typecheck` | PASS, all workspaces; final server test additions checked separately too |
| `npm run check:events` | PASS; 76 event types agree |
| `PG_TEST_URL=… npm test -- --maxWorkers=2` | PASS; 64 files, 1,032 tests; 11 gated tests skipped |
| `npm run build -w apps/web` | PASS; existing component CSS budget warning |
| `npm run test -w apps/web -- --watch=false` | PASS; five files, 43 tests |
| `npm run build:live-view-test -w apps/web` | PASS; isolated host, noVNC CommonJS warning |
| `LIVE_VIEW_K3D=1 PG_TEST_URL=… npx vitest run apps/server/test/live-view-k3d.test.ts --maxWorkers=1` | PASS; real framebuffer and browser journey, 72.19 seconds |

The final repository run took 380.40 seconds. An earlier full run overlapped edits
to the test fixture and failed; the completed rerun above passed. Initial
capacity checks were rerun in isolation, reproduced the overload and were fixed
by capping opening/active viewers at 16. No timing flakes remained in the final
run. The audit-delay and conversation-switch regressions were observed failing
before their fixes and then passing.

The live receipt joins 480,000 decoded pixels and their SHA-256 to the actual
session's start/stop event ids, member, conversation, computer and generation.
It records a 297.41 ms desktop-grant revocation close. A stalled viewer closed
with 1013 while a neighbour kept receiving pixels; peak RSS rose by 46,465,024
bytes during 32 refreshes. Kasm did not restart. Fragmented/coalesced input,
pointer, clipboard, file-transfer, unknown and oversized messages were refused.
Expiry, wrong Origin, wrong Pod UID, direct network denial and Kasm's read-only
permission passed on real gVisor.

Browser proof: [desktop](live-view/viewer-1280.png),
[390px](live-view/viewer-390.png),
[revoked access with pixels cleared](live-view/access-changed-390.png).
Both widths exercised keyboard opening, fit/actual-size and 44px buttons.
The component also cancels a pending view when its conversation input changes.
Its [mount contract](../../apps/web/README.md) is ready for P2-5; the browser test
host is separate from the product app, and the stub chat was removed.

The earlier focused authority review reproduced stale authority being renewed
after a delayed audit append. Verification repeated that attack after the fix: zero upstream connections, zero bytes and an `access_changed` stop.
The API tests also prove that a joined member with a desktop grant but no
participation is refused, delayed OpenFGA projections fail closed, revoked
tickets cannot connect, an audit outage opens no desktop, and an OpenFGA outage
closes existing viewers within two seconds.

The clean install reported 16 existing development-tool advisories (14 high,
two critical); the lockfile's existing dependency records are unchanged.
`npm audit` reports no finding for the new noVNC package, which has no runtime
npm dependencies. These tooling advisories were inspected and are not claimed
fixed by this feature. The production-only `npm audit --omit=dev` reports zero
vulnerabilities. Safe final command output is retained in
[checks.log](live-view/checks.log).

The current independent review’s blockers 1–4 and their regression evidence
are recorded in [the review-fix receipt](live-view-review-fixes-evidence.md).
Blocker 5, mounting in the product chat UI, remains deferred.

## Remaining live qualification — NOT RUN

P2-5's product chat/session-panel mounting is deferred until `work/chat-ui` lands.
Real OIDC sign-in and watching an actual assistant turn were not run: the live
fixture uses encrypted synthetic member sessions and a desktop-only computer
command. The full fresh-silo Phase 3 journey, managed-cluster TLS/HA, takeover,
control, clipboard, screenshots as conversation files and paid-provider calls
remain **NOT RUN**. The unrelated lifecycle and bridge k3d suites were skipped.
The P3-16 gated test was run separately as recorded above. Hosted CI was **NOT RUN** because this branch was not pushed. The unchanged computer
image was not rebuilt and its full image licence suite was not rerun.
