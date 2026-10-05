# S0.5: KasmVNC live view and requester takeover

For people, read [README.md](README.md) first.

Issue #14, parent #7; [ADR 0006](../../docs/adr/0006-computer-disk-and-live-view.md).
Real KasmVNC 1.5.0 runs in the gVisor computer as UID 1002. A small authenticated
OpenCrane HTTP/WebSocket gateway maps participants to Kasm read-only permissions
and the requester to write permissions only during takeover.

## Run

From the repository root on the [developer box](../../infra/devbox/README.md),
with Node 22, Docker, kubectl, the pinned S0.1b image and root `npm ci`:

```sh
./spikes/s0-5-live-view/build.sh
node spikes/s0-5-live-view/run.mjs
```

`build.sh` verifies the downloaded Kasm package, extends the pinned S0.1b image,
pushes only to the local registry and records the resulting digest. The test
client and gateway use the root lockfile's existing MIT `ws` 8.22.0. [Licences, exclusions and pins](LICENCES.md).

The runner requires `k3d-ocn`, refuses an existing `s05-view` namespace, creates
fresh resources and deletes them in `finally`. It also closes its localhost
proxy and port-forward. For an externally killed runner: `kubectl delete ns s05-view`.
Local image/cache and `.state/` evidence remain. No cloud resources or paid calls.

## Results — 1 October 2026

[evidence.json](evidence.json) records the tested source hashes, image digest and
safe receipts. This is a fresh namespace on the existing cluster, not a fresh
silo or an end-user web-app qualification. All rows except the manual OSI runtime
audit are asserted by `node spikes/s0-5-live-view/run.mjs`. Licence evidence and
manual audit commands are in [LICENCES.md](LICENCES.md); the runner does not audit licences.

| Point | Result | Proving command/output |
| --- | --- | --- |
| Authenticated gateway only | PASS | An unrelated Pod's `fetch(http://<computer>:6901)` is blocked; invalid HTTP session gets 401, invalid WebSocket session and wrong Origin get 403. Authorised WebSockets receive a real 800×600 framebuffer. |
| Participants can view, cannot control | PASS | `rfb.mjs` sends raw key and pointer packets (including Kasm’s 11-byte pointer format) even as viewer. The gateway disconnects each input sender; X `xev` records no viewer key and `xdotool getmouselocation` remains unchanged. The same session stays read-only during someone else's takeover. |
| Viewer allocation boundary | PASS | A 160 MiB binary clipboard declaration plus data is disconnected. Standard/extended clipboard, file/unknown types, excessive encoding counts and oversized fragmented WebSockets are refused. Xvnc PID/start time and Pod UID remain unchanged, zero restarts; a fresh viewer receives 480,000 pixels. Container memory is limited to 512 MiB. |
| Slow viewer isolation | PASS | Across 32 changing desktop frames, a viewer stops reading for the first eight and then receives close 1013, `Viewer buffer limit exceeded`. A second viewer and the requester receive every frame; requester pointer control works throughout. The combined gateway/client process must stay below 256 MiB RSS and 96 MiB growth, sampled every 10 ms. Exact measurements are in the evidence receipt. |
| Requester-only control | PASS | Participant POST takeover gets 403. Requester before takeover is also read-only. During takeover requester key `c` reaches `xev` and pointer moves to 150,150; desktop Chromium reads the requester's binary text/plain clipboard from X; after release requester is read-only again. |
| Agent pauses and resumes | PASS | A real Codex turn streams through the scripted provider; takeover calls `turn/interrupt` and waits for `interrupted`. New starts are refused and provider count stays fixed during control. Release closes the writer WebSocket before a new completed turn on the same thread. |
| Desktop isolation | PASS | Xvnc UID 1002, `no_new_privs=1`; private Codex files EACCES; unauthenticated local model proxy 401, model gateway 403, direct provider connection blocked. UID 1001 tools retain S0.1b's socket-denying seccomp filter. |
| OSI runtime (manual audit) | PASS | GPL-2.0-or-later KasmVNC, Debian main dependencies; non-free recommended driver and stock UI artwork absent from final runtime layers. |

The protocol client requests raw framebuffer encoding and consumes actual pixel
rectangles. The gateway reassembles bounded WebSocket messages and parses the RFB
byte stream across fragmentation and coalescing. Viewers may send only the exact
RFB 3.8/None/shared handshake, SetPixelFormat (20 bytes), SetEncodings (at most
256 entries / 1,028 bytes) and FramebufferUpdateRequest (10 bytes). No Kasm
extension is needed by this viewer. Everything else, including every clipboard,
key, pointer and file-transfer message, closes the connection before any byte of
that message reaches Kasm. WebSocket messages are limited to 4 KiB, including
fragments; partial RFB messages are bounded. Both viewer send directions check
`bufferedAmount` plus the next message and framing against a 4 MiB cap before
writing. Exceeding the cap stops forwarding, terminates that viewer's upstream
and sends close 1013 with a clear reason. The normal WebSocket close timeout
reclaims the connection if the viewer never reads again. The
requester's writer tunnel retains clipboard/control support during takeover.
Kasm read-only permissions remain a second check. Local `.state/x-events.txt` and
`.state/kasm.log` retain the X-event/server evidence without credentials.

## Boundary and limits

The spike gateway listens on a random **127.0.0.1** port. Its only WebSocket path
is `/computers/c1/view`; takeover/release are requester-authenticated POST paths.
A localhost-only `kubectl port-forward` reaches a loopback relay in the backend
Pod, which alone may connect to the computer's Kasm port. The computer itself is
never port-forwarded. This development transport substitutes for the deployed
server's in-cluster connection; it does not expose a direct Kasm endpoint.

The gateway verifies a short-lived opaque session and WebSocket Origin, injects
its own ephemeral Kasm credentials and strips the caller's authorisation. Writer
tunnels close on release; sessions/tunnels also have a two-minute lifetime.
Kasm credentials remain in the desktop UID's ephemeral home, never the PVC.
Kasm and Chromium can connect to loopback and backend TCP 3000 only. They cannot
read UID 1000's private session/token files, authenticate to its local proxy,
call the model gateway without grants, use the test-site route without its separate
short-lived desktop capability, reach direct providers or use DNS/UDP
outside the policy. Static `publicIP` prevents STUN discovery; UDP is blocked.
The model-requested tool isolation check runs in [S0.3](../s0-3-warm-pool/README.robot.md)
against the same final image. No helper runs with Codex's UID.

The test holds one active streaming Codex turn. Interruption acknowledges pause;
release starts a new turn in the same thread. It does not rewind the interrupted
provider call or claim it never happened. Gateway/model receipts remain external.
In-memory identity and takeover state are test fixtures, not production truth.

**NOT RUN:** product browser UI/rendering, full event-backed takeover audit/IAM,
TLS deployment, disconnect/crash recovery, expiry while controlling, multiple
simultaneous agent threads, quiescing an already-running tool/external effect,
paid model, fresh silo. The stock Kasm UI is excluded for licence reasons; the
real framebuffer and protocol input journey are tested. No independent review
was run by this task.
