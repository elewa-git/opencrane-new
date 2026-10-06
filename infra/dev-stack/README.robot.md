# Local dev stack

For people, read [README.md](README.md) first.

On `ocn-dev`, with Node 22, installed workspaces (`npm ci`), Docker Compose,
OpenSSL, `flock`, passwordless `sudo` for Tailscale Serve and the model-port firewall, and an authenticated
Tailscale daemon:

```sh
infra/dev-stack/up.sh --fresh
infra/dev-stack/journey.sh
infra/dev-stack/status.sh
infra/dev-stack/down.sh
```

By default, `up` runs the core journey. `--fresh` first stops this stack, deletes its
three Compose volumes, computer namespace and generated service credentials, then provisions
from nothing. The `zitadel-*` files and `zitadel.json` are retained: cloud identities survive fresh installs.
Plain `up` reuses data and running processes; owner `down` retains data and credentials.
Secondary `down --id` deletes that stack’s volumes, namespaces, admission policies
and generated directory, releasing its claim. Failed starts retain the claim for diagnosis.
These scripts do not touch `pg-test` or the `ocn` registry/MinIO; on `ocn` they
own the `opencrane-<silo>` computer and `opencrane-<silo>-gateway` relay namespaces.
Run at most three stacks per host: the stable owner and secondary ids `1` and `2`.
Operations use a separate `flock` per id; different stacks run concurrently.
Secondary readiness waits allow two minutes for startup on the shared host.
Repeated startup stops the secondary model container before migration and starts
it again afterwards, alongside the restarted server and dispatcher. Fresh secondary
stacks seed a 100,000-cent daily/monthly budget event for the stub-only journeys.
Stop leaves uncertain reservations; repeat runs retain them and the same ledger.

## Parallel journeys

The default id, `owner`, keeps the existing directory, project, ports, data and
Tailscale Serve endpoint. Never transfer its ownership marker for a feature journey.
Use the command interface below from each worktree, after `npm ci`:

```sh
stack_id=$(infra/dev-stack/claim.sh) || exit 1
export DEV_STACK_ID="$stack_id"
# Point to the existing PAT file when this worktree has no .keys directory.
export ZITADEL_KEY_FILE=/home/jente/dev/opencrane-new/.keys/.zitadel-key
infra/dev-stack/up.sh --fresh
infra/dev-stack/status.sh
infra/dev-stack/journey.sh
infra/dev-stack/down.sh
```

`up` includes the core journey. Every command also accepts `--id 1` or `--id 2`,
overriding `DEV_STACK_ID`. A missing id selects `owner`; other ids are refused.
`claim.sh` prints one free secondary id, or exits non-zero when both ids are in use.
The owner file records the worktree, claiming process id and claim start time. A
worktree that claims again gets its existing id. A claim stays reserved for 15 minutes
from its `startedAt` timestamp, even after the claiming process has ended. This gives
`up --fresh` time to start the stack. After that, a slot is stale when its claiming
process has ended and no recorded host process or running Compose container remains.
Old owner files containing only a worktree path count as claims started long ago.
The next claim reports the reclaim on stderr and records the new owner. `status`
prints `free` for an unused or stale slot, and `status` and `down` never create its
directory or owner file. Successful `down --id` removes the secondary directory.
Locks close before detached servers start, so those servers cannot keep an
operation lock held after the command finishes.

| Resource | Owner (default) | Id 1 | Id 2 |
| --- | --- | --- | --- |
| Directory below `~/.config/opencrane/` | `dev-stack` | `dev-stack-1` | `dev-stack-2` |
| Compose project | `opencrane-dev` | `opencrane-dev-1` | `opencrane-dev-2` |
| Computer namespace | `opencrane-dev` | `opencrane-dev-1` | `opencrane-dev-2` |
| PostgreSQL / NATS / OpenFGA | 55433 / 44222 / 48080 | 25100 / 25101 / 25102 | 25200 / 25201 / 25202 |
| MinIO API / console | 49000 / 49001 | 25103 / 25104 | 25203 / 25204 |
| Server / browser | 48000 / 44200 | 25105 / 25106 | 25205 / 25206 |
| Model gateway / decision / readiness / stub | 43000–43003 | 25107–25110 | 25207–25210 |
| ClamAV | 43310 | 25111 | 25211 |

Relay namespaces append `-gateway`. Each stack has its own namespace-only lifecycle
ServiceAccount and RBAC, NATS CA/certificates/NKeys, PostgreSQL passwords (including
OpenFGA’s database role), MinIO password, session encryption key and lifecycle
signing key. Compose prefixes its networks and volumes with the selected project.
Secondary directories and ports are fixed by id; conflicting overrides are refused.
The fixed secondary blocks are below this box’s ephemeral range (32768–60999),
so outgoing Kubernetes/database sockets cannot claim a future listener.
Claims probe the whole port block on IPv4 and IPv6 and skip occupied slots.
Startup checks every port before starting services and refuses foreign listeners.
Existing listeners are reused only when owned by this stack’s recorded process
groups or running Compose containers.

Secondary model processes share their NATS container’s network namespace. The
pinned Node runtime image is already used by `apps/computer/Dockerfile`; no new
runtime package is added. Docker publishes every secondary host port on loopback.
The relay reaches the gateway through its private `k3d-ocn` container address;
secondary startup/shutdown never changes host firewall rules. The existing owner
keeps its host gateway and firewall unchanged.

Secondary browsers use `http://127.0.0.1:25106` or `http://127.0.0.1:25206`.
They never call Tailscale Serve. Sessions remain HttpOnly/SameSite=Lax; local HTTP
uses non-Secure cookies with distinct names per id because cookies ignore ports.
Real Zitadel login, organisation pinning, CSRF checks and PKCE still apply. Browser
contexts and screenshots are separate; secondary screenshots live in their private
generated directories. No paid model provider is used.

The limit is **owner plus two journey stacks on the 8-core, 16 GiB box**. Each
secondary caps Compose services to 0.5 CPU each and 256–512 MiB each (models: one CPU / 768 MiB), Angular to two
build workers and a 768 MiB JS heap, other Node processes to 256 MiB JS heaps, and
computers to four Pods / 2 GiB of memory limits / four 1 GiB PVCs. The warm pool
stays at zero. These are dev qualification limits, not production sizing. Run one
journey per stack, avoid concurrent repository builds while qualifying, and tear
down secondaries when finished. Exhausted slots queue instead of creating a fourth
stack; do not work around the limit with custom directories or ports.

The [parallel qualification receipt](../../docs/process/parallel-stacks-evidence.md)
records concurrent journeys, owner continuity, failures and teardown evidence.

## Services and identities

Compose pins PostgreSQL 17, NATS 2.15.0, OpenFGA 1.21.0 and the same MinIO image
as `infra/devbox` by digest. Licences are PostgreSQL, Apache-2.0 (NATS/OpenFGA)
and AGPL-3.0 (MinIO), all OSI-approved. No new package dependency is introduced;
the worker adds the existing handlers workspace to the ops package.

All published ports bind to `127.0.0.1`: PostgreSQL 55433, NATS 44222, OpenFGA
48080, MinIO 49000/49001, server 48000 and Angular 44200. Container listeners
are inside the Compose network; no gRPC, metrics or NATS monitoring port is
published. `pg-test` keeps 55432. Override the corresponding `*_PORT` variables
when generating a new owner stack; secondary port blocks are fixed in `identity.ts`. Clients receive URLs via environment
and a generated Angular proxy file; application code has no Compose branch.

`npm run provision` uses only the command NKey/TLS identity. The server receives
that identity and a read-only PostgreSQL role. Separate members and MCP catalogue
processes use the projection NKey and own the projection database. The computers
projection does the same. The dispatcher uses its own NKey and database; pg-boss
updates OpenFGA and runs the lifecycle reactions. OpenFGA uses its own PostgreSQL
database. Startup installs the checked SandboxTemplate, zero-size pool and
namespace-only ServiceAccount on k3d `ocn`, then writes a short-lived kubeconfig
beside the other generated credentials. The worker entrypoint is also usable
outside this stack: `npm run worker -w apps/ops -- members|mcp-catalogue|computers|dispatcher`.
It uses the same settings as replay; dispatcher also requires the silo and OpenFGA
binding. Shutdown aborts readers, stops jobs and closes connections.

## Local credentials and access

Generated files live in `~/.config/opencrane/dev-stack/` (directory 0700,
files 0600), or a dedicated `DEV_STACK_DIR` outside the repository. Never print,
copy into the repository or share these files. Logs and PID records live there too.
The generator reuses the test fixture's CA/certificate/NKey issuer, with 30-day
certificates. Use `--fresh` to replace expired credentials and disposable data.
These local files stand in for a secret store; production lease rotation is not
qualified here. The NATS container mounts only its certificate/key and CA public
certificate, never client seeds or the CA signing key. Host processes receive
only their settings, although the host account can read all its own files.

Tailscale Serve provides `https://<machine>.<tailnet>.ts.net/org/integrations`
(on this box, `https://ocn-dev.tail00285e.ts.net/org/integrations`). HTTPS proxies
to Angular, which forwards `/api`, `/auth`, `/members` and `/ws` to the server.
Only tailnet devices allowed by the tailnet policy can connect. No Funnel is used.
The stack refuses to overwrite an existing Serve configuration it does not own;
`down` removes the stack's HTTPS service.

## Zitadel sign-in

The stack uses `https://weownai-oidc-8dwlat.eu1.zitadel.cloud` with the
[non-secret configuration](zitadel.json). Only **OpenCrane 2 Dev** is managed:

| Resource | Name | ID |
| --- | --- | --- |
| Organisation | OpenCrane 2 Dev | `393311211338337681` |
| Project | OpenCrane 2 Dev | `393311211539664273` |
| OIDC web app | OpenCrane 2 Dev Web | `393311211707436433` |
| Client | OpenCrane 2 Dev Web | `393311211707501969` |
| Human owner | opencrane2-dev-owner | `393311211875208593` |
| Human member | opencrane2-dev-member | `393311212596681804` |
| External owner identity | existing WeOwnAI user | `378127409465593948` |

The owner has `ORG_OWNER` in this organisation. OpenCrane product permissions
come separately from invitation/join events and OpenFGA, never OIDC roles.
The app uses code + S256 PKCE and client-secret POST authentication, with redirects
`https://ocn-dev.tail00285e.ts.net/auth/callback` and
`https://ocn-dev.tail00285e.ts.net/` after logout. The server pins the resource-owner
claim to this organisation, requesting `urn:zitadel:iam:user:resourceowner`.

Every owner `up` runs `zitadel-setup.ts --restore-owner-app` under the shared
Zitadel setup lock. This idempotent guard restores development mode to `false`
and permits only the two owner HTTPS URIs above, preserving other OIDC settings.
The same command can repair the pinned owner app without starting services or
reading owner credentials; its output contains only ids and before/after redirects
and development mode. It requires the management PAT via `ZITADEL_KEY_FILE`
(default `.keys/.zitadel-key`), as secondary setup does.

The setup adds one role-free external user grant for subject `378127409465593948`
to the OpenCrane project. It does not create or change that user, grant the project to
the WeOwnAI organisation, or change either organisation. The login request remains
unchanged: the resource-owner scope returns each user's own organisation, so it does
not need an organisation hint. The server normally requires the OpenCrane organisation
claim, but the dev environment allows this exact issuer and subject; all other subjects
remain pinned. OpenCrane roles still come only from events and OpenFGA.

Each `up` also runs a dev-only owner bootstrap after the projections and dispatcher
start. Through the command NKey it conditionally appends `member.invited` and
`member.joined`, binding that issuer and subject to owner member `jente-rosseel`.
Existing stream state is checked first, so plain and `--fresh` runs do not duplicate it.
This dev-only bootstrap for `jente@elewa.ke` remains in place. Production installs
use the [one-time token command and claim screen](../../apps/server/README.robot.md#first-owner-bootstrap-12),
which refuse a silo that already has an owner. Dev exceptions for external
identities do not apply to the token claim; its user must belong to the configured
organisation. Ownership transfer is a separate feature (#24).

For a fresh secondary token qualification, set `DEV_OWNER_BOOTSTRAP=0` on
`up.sh --id "$stack_id" --fresh`. This skips the dev owner events and automatic
member-seeding journey, and sets the server's `BOOTSTRAP_TOKEN_FILE` to the
secondary directory's `bootstrap-token.json`.
Generate that file with the installation command after startup. The override
only applies to secondary stacks; the owner stack always keeps its bootstrap.

To rerun the setup, with `.keys/.zitadel-key` available locally:

```sh
flock "/tmp/opencrane-dev-stack-$(id -u).lock" \
  node --experimental-strip-types infra/dev-stack/zitadel-setup.ts
```

The script searches by exact organisation name, checks the recorded ID, and
scopes all management requests to that org. It creates missing named resources
and reuses existing ones, including the one external user grant. It does not read or
change the external user. It does not rotate an existing client secret or password;
missing secret files fail closed. The PAT is read only into an Authorization header,
never printed or passed in argv. No other organisation or instance setting is changed.
The script uses the documented [Zitadel management API](https://zitadel.com/docs/apis/resources/mgmt).

Private files under `~/.config/opencrane/dev-stack/` (0600):
`zitadel-client-secret`, `zitadel-owner-password`, `zitadel-member-password` and
`zitadel.json` (user IDs, login names and password paths). `auth.env` references
the client secret by `OIDC_CLIENT_SECRET_FILE`; the launcher reads it and uses
`libs/auth`'s existing environment-variable indirection. Neither the PAT nor test
passwords are supplied to the server. Run setup before first bring-up. A different
checkout must first stop the old stack and deliberately transfer `stack-owner`;
normal scripts continue to refuse a foreign owner marker. Feature tasks use secondary ids instead.

Open `/` on the tailnet URL and choose **Continue with single sign-on**. Credentials
are entered only on Zitadel. **Sign out** submits a native form POST. The server
clears the OpenCrane cookie and sends a 303 to Zitadel with the encrypted session’s
ID token in the `Location` header only. Zitadel signs out **all accounts in that
browser**, returns home without a chooser, and the next sign-in requires credentials.
Zitadel may first ask which remembered account to use on that next sign-in.
The ID token is never returned in JSON or read by page JavaScript. Email-link delivery is not qualified; its shared state
says unavailable, and no sent-email screen or lockout count is invented.

The journey signs in as both real users in separate Playwright browser contexts
at 390px and uses their actual encrypted cookies for HTTP and WebSocket requests.
It refuses hostile/missing logout Origins and requests without a session. It checks
an empty 303 body and probes manual/follow fetch, XHR, the DOM and page cookies for
ID-token exposure. Native keyboard sign-out returns without a chooser, removes
the OpenCrane cookie and is followed by a successful sign-in requiring credentials.
The five process logs are checked for the current ID token without printing it. Dev-only bootstrap
invitations bind these subjects to stable member IDs; they do not define the
production first-owner policy. Each run adds a new invitation/join and MCP row.
Wrong-org and expiry checks run another real server on temporary loopback ports:
its pin differs from the generated user's real token org while the owner's exact
allowlist entry remains configured, or its session lasts two seconds.
Only those browser auth requests go to the probe. No other cloud org is accessed.

An explicit diagnostic fallback remains for an unreachable issuer only:

```sh
DEV_STACK_OFFLINE_FALLBACK=1 node --experimental-strip-types infra/dev-stack/journey.ts
```

It checks discovery reachability, uses minted five-minute **dev-only** cookies,
prints **FAIL sign-in** and exits non-zero even if the service checks pass.
`up.sh` and `journey.sh` always use real login; they never silently take this path.

For secondary bring-up, `zitadel-setup.ts` checks organisation
`393311211338337681` and existing project `393311211539664273`. Under a shared
setup lock, each id creates or reuses its own app, `OpenCrane 2 Dev CI <id>`, and
users `opencrane2-dev-ci-<id>-owner` and `opencrane2-dev-ci-<id>-member`.
The owner app and users are never modified, and no owner credentials are read.
Secondary users need no Zitadel administration role; product roles come from events.
Each secondary app permits only its id's exact callback and logout URIs from the
table above, with no globs. Development mode allows HTTP, as required by
[Zitadel’s app settings](https://zitadel.com/docs/guides/manage/console/applications-overview).
Existing secondary apps with unexpected redirects are refused without mutation.

The secondary app secret and randomly generated user passwords persist in
`~/.config/opencrane/dev-stack-ci-<id>/` (0700), with files at 0600. Setup copies
only those credentials to its disposable secondary directory (also 0600), and
configuration uses the secondary client ID. `down --id` removes the disposable
stack but retains these private credentials and cloud identities for reuse.
Missing retained credentials fail closed; setup never rotates existing secrets.
No other organisation, project, grant or instance setting is changed.

## Qualification

The journey uses running services, never mocks: an HTTP join reaches SQL and
OpenFGA while an authorised WebSocket is subscribed; seeded `mcp.*` events produce
typed admin API rows; anonymous and member access are refused; members and MCP
catalogue replay verify online. The joined member also reaches a Ready gVisor
computer; native suspend/resume and a deleted Pod retain a file on its PVC. It
also fetches the web page over tailnet HTTPS.
Each invocation adds invitation/join events for the two test members and a new MCP row;
fresh runs remove this local business state.
Failure exits non-zero. Private logs identify a failed stage without printing
credentials. `status` reports the host processes, Compose and Tailscale service.
The owner's own browser sign-in remains a manual check and is **NOT RUN** by these scripts.

Run the repository gates with the existing control database:

```sh
npm run lint
npm run typecheck
npm run check:events
PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres npm test
npm run build -w apps/web
npm run test -w apps/web -- --watch=false
node --experimental-strip-types --test infra/dev-stack/*.test.ts
npx tsc -p infra/dev-stack/tsconfig.json
shellcheck infra/dev-stack/*.sh
infra/dev-stack/up.sh --fresh
infra/dev-stack/up.sh --fresh
npm run visual:signin
ss -ltnp
```

Compare listeners with a snapshot from before bring-up: no new `0.0.0.0`, `*`
or `[::]` listener is allowed. Existing host SSH is outside this stack.
See [sign-in evidence](../../docs/process/signin-evidence.md) and [the original evidence receipt](../../docs/process/dev-stack-evidence.md) for results
and conditions not qualified by these local journeys.

## Phase 2 model gateway

`up.sh` starts the model decision and pinned agentgateway binary, budget projection,
settlement handler and a loopback-only scripted SSE provider. It derives public
JWKS from the same lifecycle signing key and supplies the same `TOKEN_ISSUER`.
The decision process only reads the public keys. The dev stack always sets
`MODEL_UPSTREAM=127.0.0.1:43003` and uses a disposable placeholder key; it neither
loads `.keys/.openai-key` nor calls OpenAI.

Every `up.sh`, including `--fresh`, runs the idempotent model grant migration
with the command connection and silo id before decision services start. A
repeat startup stops the server, dispatcher and model services first to keep
event writers out of the migration. The journey checks existing model grant
history and waits for new member/assistant grants in OpenFGA before chat.
Older silos still need the controlled OpenFGA and dispatcher subscription
upgrade described in the [ops instructions](../../apps/ops/README.robot.md#model-grant-upgrade).

The joined member's Ready computer receives a lifecycle turn credential. The
journey installs it over the private control socket, then runs as the Codex UID
through the authenticated local proxy, k3d relay, model gateway and decision.
It asserts a completed stub response and the turn's `budget.reserved` event.
Unit/integration gates additionally prove expired, pre-resume, pre-loss and
mismatched computer/generation credentials cannot reserve money.

Ports 43001–43003 are loopback-only. agentgateway 1.5 binds 43000 on all interfaces;
startup first installs a dedicated IPv4/IPv6 firewall chain allowing only loopback,
Tailscale and the private k3d bridge. Shutdown removes that chain after stopping
the gateway. No public interface or Funnel path is permitted.

The relay lives in `opencrane-dev-gateway`, outside the computer admission namespace.
A dedicated NetworkPolicy permits only that namespace's gateway Pods on port 3000;
the computer uses its Service IP without DNS egress. Startup provisions both and
sets `computer-runtime` automatically. The relay has no credential. Existing
handler subscriptions need a controlled rebuild when introducing `settle-budget`;
the fresh run creates them from the combined catalogue.

See the [model integration evidence](../../docs/process/models-evidence.md) for
fresh/repeat journeys, owner-stack restoration and unqualified conditions.

## Browser chat qualification

The joined member opens **Open workspace**, sends through the composer, observes
streamed stub text, reloads and reads the saved answer. A second turn is stopped
mid-stream and its partial text survives reload. Both 1280px and 390px use real
sign-in; live screenshots go to `docs/design/chat/live/`. The journey records
first-token and completion times, including a message sent to a suspended computer.
The stub spaces deltas by 500ms
so Chromium can observe intermediate renders. For the journey’s cancellation
prompt (`Say hello again.`), the stub pauses for up to 30 seconds after its first
delta, ending the wait when cancelled. This makes the real browser Stop check
predictable under concurrent load; the same partial-text assertion still applies. The overall journey timeout is fifteen minutes, with 120 seconds for event and
computer readiness. No OpenAI credentials are read.
The stub fixture sets a 4,000-cent daily ceiling through a budget event so fresh
and warm journeys fit alongside the worst-case reservations retained by Stop.
It does not invent usage receipts or release uncertain reservations.
The receipt is [chat UI evidence](../../docs/process/chat-ui-evidence.md).

Secondary journeys also prove monthly budgets through the real owner and member
sessions. At 1280px and 390px, the owner saves paying-group and assistant ceilings
in Spending (`/org/spending`), after **Spending loaded**; each zero-cent ceiling
refuses a stub chat call with an explanation retained after reload and no reservation. Repeated default-group
migration preserves existing ceilings without another installation event.
Screenshots for fresh and repeat runs go to `docs/process/p3-13-live/`. The journey
restores usable group and assistant ceilings before the next plain startup.
It also sets the daily safety cap to 5,000 cents through the owner UI, retaining
unconfirmed Stop reservations while leaving enough headroom for the repeat run.

Secondary journeys also read each member's completed stub turn in Action history,
with the permission decision and observed outcome shown separately. The owner reads
safe organisation changes; another joined member is refused private history, and
members are refused organisation history. Owner/member sessions use real Zitadel
sign-in; the extra member uses a dev-only signed session to test resource authority.
Both views and the refusal screen are checked at 1280px and 390px. Private chat,
query, conversation-id and bearer canaries must be absent from live process and
model/gateway logs. Fresh/repeat screenshots go to `docs/process/p3-19-live/`;
the [audit receipt](../../docs/process/p3-19-audit-evidence.md) records qualification.

## Browser approval qualification

Every journey also configures the credential-free `approval-journey` MCP route
against the local recording stub. It seeds reviewed Ask policy, grants and an active
tool turn through events, then calls the running gateway with lifecycle credentials.
The signed-in requester sees the 8g card, approves in the browser and retries the tool once.
A refused or ambiguous decision submission uses Check status before a safe retry,
with at most three submissions and three status reads per submission; the journey
records the submission counts. A failed status read never authorises a retry.
The stub must record exactly one call with unchanged bytes and an allowed decision;
a second retry and a denied call must produce no additional upstream effects.
Requested, approved, used (outcome unknown) and denied cards survive reload at
1280px and 390px. Screenshots go to `docs/process/p3-2-live/`.
This qualifies browser approval and gateway admission, not native Codex MCP
continuation or an external tool's final outcome. No OpenAI call is made.
Approval tools explicitly cost zero; the journey uses the stored installation
paying group. The monthly-budget journey above owns the test ceiling changes.

## Browser desktop qualification

The chat journey opens **Watch your computer** from the real member's conversation
at 1280px and through the session overlay at 390px. Without a shared-desktop grant
it shows **Unavailable**; a dev-only grant event then allows viewing. The viewer
decodes the deployed computer's 800×600 framebuffer through the selected stack origin, the
generated Angular proxy and the server's `computer-lifecycle` service account.
A known window is fixture activity to make pixels recognisable; a real Codex turn
also completes through the stub provider while the viewer is open. Revoking the
grant closes the socket, clears pixels and records the stop audit. Keyboard
opening, Escape, fit/actual-size and 44px targets are checked. Screenshots and
receipts go to `docs/process/live-view/conversation-*`.

For ten instrumented live-view repetitions on a claimed secondary, run
`node --experimental-strip-types infra/dev-stack/live-view-repeat.ts <output-directory>`.
The directory defaults to `docs/process/i77-live-view`; choose a new directory
to retain an earlier batch. Each run records safe server stage/lease timings
and browser admission/connection milestones. `replyTiming.firstDeltaMs` measures
the time from the browser's message POST to its first received `agent.message_delta`
frame. A null value means the measurement was not reached before the run ended.
No message or reply text is retained by this observer.
Run `python3 infra/dev-stack/live-view-resources.py <output-file>` during a batch
to sample RSS, file descriptor counts and host CPU pressure every five seconds.
It checks the selected secondary belongs to this worktree. It uses `sudo -n ls`
to count descriptors for container processes with another uid. It records missing
readings as errors. V8 heap used is unavailable because the server has no heap endpoint.
See the
[diagnostic receipt](../../docs/process/i77-live-view.md#safe-timing-records)
for field meanings and collection limits.

For screenshot qualification on a claimed secondary, run
`node --experimental-strip-types infra/dev-stack/screenshot-journey.ts fresh`
after `up.sh --fresh`, then use `repeat` after plain `up.sh`. Real Zitadel sessions
capture the deployed desktop, open the saved image from the conversation and panel,
and reload at 1280px and 390px. Repeat also reopens the fresh run's screenshot
when capture passed; otherwise it records that persistence check as NOT RUN.
A signed-in non-participant with a desktop grant is refused viewing, capture and
file access. Receipts and screenshots go to `docs/process/p3-18-live/`.

## Browser upload qualification

The browser starts a draft, attaches `project.pdf` through the native file picker,
waits for delivery, previews the promoted original and asks for its project code.
The prompt does not contain the answer. The stub requests `exec_command` and only
answers Willow-47 after Codex returns the MarkItDown text. The journey also checks
reload, EICAR/type/size refusals and text/image previews, at 1280px and 390px.
It drops the first upload response after the server handles it, clicks Retry and
checks that only one attachment exists. The size check selects a real sparse file
through the native picker rather than copying 20 MiB through Playwright.
If a response is lost, the journey clicks the shipped Retry control at most twice
with a one-second pause. Known type, size and malware refusals are never retried.
Full Chromium supplies its native PDF viewer; headless-shell cannot render PDFs.
Screenshots are `docs/design/chat/live/upload-*.png` and `preview-*.png`.
The [upload receipt](../../docs/process/upload-evidence.md) records the results.
The ordinary journey never uses a paid provider.
Its login fixture retries Chromium `ERR_NETWORK_CHANGED` at most twice; recovery
after submitted credentials must still have a valid server session, followed by
the normal identity, organisation and cookie assertions.

## Budget journey cleanup

Each zero-cent browser check restores that scope in a `finally` block. The calling
journey also restores the paying group, assistant and global limits after the audit
and budget browser checks, whether they pass or fail. Cleanup uses the authenticated
budget API rather than loading the Spending page. It waits for the budget table to
catch up before the next step. Monthly test limits are 20,000 cents; the daily global
limit is 5,000 cents. It attempts every scope and reports any failed restoration.
