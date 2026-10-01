# S0.1b: Codex-only forwarding under gVisor

Issue #13, parent #7; decision in [ADR 0003](../../docs/adr/0003-harness-codex.md#s01b-computer-proof--1-october-2026).
This disposable spike runs **Codex 0.159.2 app-server → local authenticated
proxy → agentgateway 1.5.0 → scripted OpenAI Responses HTTP/SSE provider**.
The computer is a real Agent Sandbox 1.0.4 `Sandbox` (`v1beta1`) Pod on k3d
`ocn`, with `runtimeClassName: gvisor`. CRI inspection also checks
`runtimeType: io.containerd.runsc.v1`; this is not merely a manifest test.

## Run

From the repository root, with the box described in
[infra/devbox](../../infra/devbox/README.md), Node 22, Docker, kubectl and an
x86-64 Linux GCC with static libc available:

```sh
node spikes/s0-1b-proxy-gvisor/run.mjs
```

No key is read and no paid endpoint is contacted in this mode. No cloud resources
are created. The runner refuses an existing `s01b-proxy` namespace, builds and
pushes locally, resolves the image digest, creates fresh resources, tests them,
and deletes its namespace in `finally`, including after an assertion fails.
It requires the `k3d-ocn` context. It leaves the existing cluster, controller,
RuntimeClass, registry and other namespaces alone.

It keeps only the local build/cache, the `opencrane/s01b` repository in the local
registry, and gitignored `.state/` evidence. An external interruption can prevent
`finally`; remove this spike's namespace with `kubectl delete ns s01b-proxy`.
`docker image rm 127.0.0.1:5001/opencrane/s01b:spike` removes the local image tag;
registry blobs are left for the box's normal registry cleanup.

## Results — 1 October 2026

**All four requested points PASS for the local stub journey.** These are fresh
Pods and fresh token stores on the existing developer cluster, not a fresh
cluster or a production silo. See [evidence.json](evidence.json) for the source
base, tested image, runtime and exact safe receipts. The runner saves the actual
provider requests in `.state/model.jsonl`, decisions in `.state/decisions.jsonl`,
Codex notifications in `.state/driver.jsonl`, and external gateway access logs
in `.state/gateway.log`. Tokens are stripped before the provider; the runner
also checks that issued token values never appear in the captured messages,
provider requests or decisions. Only token fingerprints enter decision logs.

| Point | Result | Proving command and observed output |
| --- | --- | --- |
| 1. Stream through proxy and gateway | **PASS** | Runner starts two threads on one app-server and overlaps their turns. Both emit at least three `item/agentMessage/delta` notifications and `turn/completed` with `status: completed`. The provider records three requests: two for the shell turn and one for the other thread. |
| 2. Only the Codex user can use the proxy | **PASS** | Missing local caller capability returns **401**. The provider asks Codex for `exec_command: node /spike/probe.mjs`; the following provider request contains `ISOLATION_PASS`, UID **1001**, zero effective capabilities, `NoNewPrivs=1`, denied `setuid(1000)`, private files **EACCES**, and proxy/gateway/model/issuer/IPv6/control sockets **EPERM**. Codex runs as **1000**. |
| 3. Per-thread, expiring turn tokens | **PASS** | Two overlapping threads produce different token fingerprints. Direct gateway probes with A's token and B's header, an expired token, a forged token and a revoked token return **403**. The decision log records `thread mismatch`, `expired`, `unknown token`. Provider request count stays unchanged. Completed turns lose their proxy entry and return **403** locally. |
| 4. Kill during a call | **PASS** | Runner waits for the provider's held-call receipt and a streamed delta, then executes `kubectl -n s01b-proxy delete pod/computer --force --grace-period=0 --wait=true`. Original Pod UID is recorded. No turn completion occurred; external provider and gateway logs retain the thread. The call was sent. |

The tool's observed output (through Codex, not a substitute `kubectl exec`):

```text
ISOLATION_PASS
uid=1001 noNewPrivs=true cannotBecomeCodex=true callerAbsentFromEnvironment=true
/home/codex/{private,caller,tokens.json,.codex/config.toml}: EACCES
/proc/<UID-1000-process>/environ: denied (5 processes)
proxy/gateway/model/issuer/ipv6/control/executor: EPERM
```

`probe.mjs` asserts each field, rather than merely printing expected labels.
The runner then asserts the marker appears in the real provider's received
`function_call_output`. A failed probe cannot turn a scripted final reply into
an isolation PASS.

NetworkPolicy **is enforced by this k3d/k3s setup**. The runner proves that
UID 1000 can connect to gateway port 3000, cannot connect to model port 9003
(observed **ECONNREFUSED**, not a timeout), can reach the model health endpoint
when the policy is removed, and cannot reach it after the policy is restored.
The model health control does not perform a model call, including in real mode.
No public ingress is allowed, no ServiceAccount token is mounted, and computer
Pod egress permits only the backend Pod on TCP 3000. No DNS exception is needed.

## Boundary and decision

Use Codex's native **exec-server environment**, with `include_local = false`,
for tools. A small root supervisor starts an executor with empty supplementary
groups, UID/GID 1001, no effective capabilities and `no_new_privs`. Before exec,
it installs a seccomp filter inherited by every descendant. The filter refuses
`socket`, `connect`, `io_uring_setup`, `ptrace`, process-memory reads/writes and
`pidfd_getfd`; it rejects other syscall architectures and x32. There is no
setuid executable. Changing the shell or granting a Codex approval cannot
remove this filter or become UID 1000. Tool commands are unrestricted for files
their Unix user can access (`danger-full-access`); this deliberately avoids
claiming Codex's own nested sandbox is the security boundary under gVisor.
Approval policy is `on-request`.

The executor communicates over stdio, relayed through a **0600 Unix socket in
`/run/codex` (0700, UID 1000)**. Root handles only that fixed executor launch;
it is not a general command broker. The bridge and proxy also run as UID 1000.
Codex's model client uses loopback HTTP with a fresh 256-bit caller capability
(expiry 10 minutes), supplied via `env_key`. This is a local authentication
credential, not a provider key. Tool environment inheritance is disabled and
the executor starts with a cleared environment. The capability, session files
and turn-token canary are under the Codex user's private home. The shell cannot
read them, read the Codex process environment, or create any socket at all.
The proxy rejects an absent/wrong credential before looking up the turn.

This is the alternative to a Unix HTTP transport supported by the ticket:
**authenticated loopback HTTP plus kernel-enforced separation of tool execution**.
A loopback address or Unix socket alone, with Codex and tools sharing a user,
would not provide this guarantee. Kubernetes NetworkPolicy cannot distinguish
two users inside one Pod, so it complements rather than replaces seccomp here.

The bridge provisions a token before `turn/start`; the proxy maps `session-id`
to that thread's token and refuses missing/expired entries. The bridge drops
its entry on `turn/completed`. agentgateway's HTTP `extAuthz` calls the separate
decision service, which checks the computer token, opaque turn token, exact
thread match and strict expiry before forwarding. The issuer is loopback-only
in the backend Pod, accessed by the test owner through `kubectl exec`; the
computer cannot mint tokens. Production issuance belongs to the server.

**ponytail:** opaque random tokens with a 120-second maximum lifetime and an
in-memory issuer are enough to test these boundaries. This is not a second
production IAM, event store or budget system; use the existing S0.2 decision
service design for those responsibilities. Real IAM/requester claims, JWT
verification and durable revocation are outside this spike.

The held stream's gateway access log reports **HTTP 200**, because SSE headers
were already sent. This does **not** mean the model finished or usage settled.
Use external observations to distinguish sent calls from local intent; absence
of a receipt still leaves an ambiguous outcome and does not authorise replay.
No exactly-once effect, settlement, event append or crash-resume guarantee is
claimed. The controller can create a replacement Pod; the receipt names the
original UID so recreation is not mistaken for survival.

## One-command real-model check — NOT RUN

After the owner places a private key file and chooses a model, run:

```sh
node spikes/s0-1b-proxy-gvisor/run.mjs --real /absolute/private/openai.key MODEL_ID
```

This is an explicit paid-call opt-in for a later owner-run check. **It was not
executed in this spike.** The key file must have no group/other permissions.
The runner mounts it only into the backend adapter using a temporary Kubernetes
Secret, never the computer or gateway. That adapter makes at most **one** request
to `https://api.openai.com/v1/responses`, with tools removed, output limited to
64 tokens, `store: false`, a 60-second deadline and no retries. It streams the
response back over the same real gateway, proxy and app-server path. The
namespace and Secret are deleted afterwards. Total input cost depends on the
selected model; this is a call/output limit, not a monetary budget implementation.

Real mode checks one completed, streamed turn and runtime/network/caller checks;
it does not label the stub-specific scripted shell/token/crash suite as passed.
Provider inference, this optional key path, MCP, approval pause/resume, sub-agent
inheritance, session-volume recovery and a fresh entire silo are **NOT RUN** by
S0.1b. Commands and file tools launched through the native exec-server run as a
separate user under a seccomp filter with no networking. Codex itself runs as
UID 1000 and can reach the proxy and gateway. Same-UID local MCP servers,
Playwright or browser helpers, and package helpers are not allowed in the
computer until they have a separate identity and an authenticated egress route
through agentgateway. Native exec-server is experimental and its version is
pinned.

## Implications for Phase 2

`npm install` currently fails: npm is deliberately removed, and an
executor-launched replacement cannot perform DNS or connect. Network `git
clone` fails: git is absent from the image, and adding it alone would not
overcome seccomp. Playwright web browsing fails through the executor because
Chromium cannot create network sockets. Local MCP servers stay outside the
computer, as the existing `<silo>-mcp` design proposes. The route out needs an
authenticated egress broker through agentgateway, with destination allowlists,
SSRF controls and DNS controls. Access needs either a pre-opened or brokered
channel, or a separately confined process allowed to connect only to the
gateway.

## Pins, licences and gates

[LICENCES.md](LICENCES.md) records the image/dependency inspection. Base Node and
agentgateway image references are pinned by digest; Codex's two Linux packages
are integrity-pinned in `package-lock.json`. The runner resolves its locally
built image to a digest before creating either Pod. Host pushes use
`127.0.0.1:5001`; cluster pulls use `k3d-ocn-registry:5000`.

Repository gates, using the supplied PostgreSQL control URL:

```sh
npm run lint
npm run typecheck
npm run check:events
PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres npm test
```

Lint: **PASS** (one existing function-length warning). Typecheck: **PASS**. Catalogue: **PASS**, 70 types. Tests: **PASS**, 42 files /
821 tests, real PostgreSQL, NATS and OpenFGA seams included. The final spike
passed twice on fresh resources; receipts are recorded in [evidence.json](evidence.json).
Independent review: **NOT RUN**, as requested. No push is part of this work.
