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
Fresh secondary startup clears only this worktree's `apps/web/.angular/cache`, after
stopping its website. The daily checkout keeps installed packages when the lock file
is unchanged, but local workspace exports can change between commits. Reusing Vite's
saved dependency bundles can otherwise leave the sign-in page blank with a missing export.
These scripts do not touch `pg-test` or the `ocn` registry/MinIO; on `ocn` they
own the `opencrane-<silo>` computer and `opencrane-<silo>-gateway` relay namespaces.
Run at most three stacks per host: the stable owner and secondary ids `1` and `2`.
Operations use a separate `flock` per id; different stacks run concurrently.
Service readiness waits allow two minutes on secondary stacks and one minute on the owner.
Website readiness has its own five-minute deadline, measured with a monotonic clock.
It still requires a successful HTTP response from `/org/integrations` on the Angular
server, started with the generated proxy configuration. If the recorded website process
stops, startup fails promptly and points to the private `web.log`, without printing
its contents. A successful check prints
`PASS website readiness: <milliseconds>ms`, measured from the request to start or reuse
the website process.
The origin check and browser journeys run afterwards. Fresh starts still clear the cache.

The retained 22 October provider-start run built the website in 208.291 seconds, then
listened on slot 1's port 25106. Its previous two-minute wait had already failed.
The same day's upload-list run retained only `Building...` and a web timeout, so it does
not establish that run's eventual build time. The cache change in #578 only enabled
Angular caching in CI; fresh secondary starts remove this cache before the build.
No new web dependency was introduced by that change. Keep the cold-build allowance
separate from the other services' deadlines.

`nice -n 10 node --experimental-strip-types --test infra/dev-stack/stack-start.test.ts`
checks a simulated 208.291-second build, a website that never becomes ready and an exited
website process. It also checks owner rollback with synthetic processes; it never starts
or changes the live owner stack.

Repeated startup stops the secondary model container before migration and starts
it again afterwards, alongside the restarted server and dispatcher. Fresh secondary
stacks seed a 100,000-cent daily/monthly budget event for the stub-only journeys.
Stop leaves uncertain reservations; repeat runs retain them and the same ledger.

## Website startup check, 22 October 2026

Source: `db18a7bf1882515421a8955010e898183fcb183f`. Both attempts ran
`nice -n 10 infra/dev-stack/daily-fresh.sh` with `ZITADEL_KEY_FILE` pointing to the
existing private credential file. The launcher claimed secondary slot 1 with `claim.sh`,
ran `up.sh --fresh` with the free stand-in model, then removed the slot and its volumes.
No separate test suite or repository build from this task ran during either attempt.

- First attempt: **FAIL** before website startup. The provider create request returned
  HTTP 503, then its receipt request returned HTTP 404. Website and browser checks:
  **NOT RUN**. Private sanitised logs are in
  `~/.opencrane/daily-fresh/nightly-20261022T211218-233b6bf6-5e86-4319-a7c1-78840cb8eb99/`.
- Second attempt: website readiness **PASS**, **56,406 ms** from launch to the successful
  HTTP check. Angular reported **51.681 seconds** for the cold build and listened on
  `127.0.0.1:25106`. The generated proxy and origin check were used.
- Browser checks **PARTIAL**: the run passed sign-in, a streamed stand-in reply, reload,
  Stop, upload and preview assertions, then timed out after 120 seconds waiting for the
  attached PDF's answer in `browser-upload.ts`. The whole fresh run remains **FAIL**.
  Later browser journeys and replay checks: **NOT RUN**. Private sanitised logs and
  screenshots are in
  `~/.opencrane/daily-fresh/nightly-20261022T211505-1d48d147-b640-4a88-9e05-da853665efd4/`.
- Cleanup **PASS** for both attempts: slot 1's generated directory was removed and no
  Compose containers remained for `opencrane-dev-1`. The owner stack was not used.

The earlier provider-start task retained its eventual **208.291-second** Angular build
in `/home/jente/.fleet/demo-provider-start/events.jsonl`. The upload-list failure logs
are under `~/.opencrane/daily-fresh/nightly-20261022T193759-c67e4dbf-24db-4d87-9faf-333d9bbb15fc/`.
The earlier task also recorded a host load average of 28.53 after that build. The website
still uses two build workers and a 768 MiB JavaScript heap on a secondary stack. That
measurement justifies allowing five minutes even though the second attempt here was faster.
This check does not qualify every demo journey or a paid model.

Local checks: **PASS**, 18 startup and model-environment tests twice, 438 event-security
tests once and the event catalogue check (149 event types). The regression failed before
the fix in test-only commit `7b26ad748`. All checks used `nice -n 10`; the event-security
run set the requested `PG_TEST_URL` and did not use a database.
Workspace typecheck and the focused strict typecheck for the changed startup code: **PASS**.
Repository lint, including Knip, Markdown, links, licences and changelog checks: **PASS**
with `NODE_OPTIONS=--max-old-space-size=6144`. The initial lint attempt exhausted Node's
default 4 GiB heap before reaching the later checks. CI already gives lint an 8 GiB heap.
Full root suite: **NOT RUN**.

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
process has ended and no recorded host process, running Compose container or
package namespace remains. The package owner record keeps the worktree, slot,
cluster, namespace UID, Helm release and heartbeat. Kubernetes errors count as
busy. `package-down` checks those identities before removal; ordinary secondary
`down` does the same first. Package preparation checks for running Compose host
processes and containers in that slot. The installer saves a random `installId`
before Helm runs and passes it as the `opencrane.dev/install-id` release label.
Cleanup requires that label to match the saved ID. If the launcher stops before
saving the release Secret's UID, cleanup recovers the UID from the matching Secret.
A later foreign or unlabelled release is refused, even in the owned namespace.
Older records without an install ID cannot authorise release removal.
If Kubernetes is unavailable, secondary `down` still
stops Compose, keeps the package record and reports that the package remains.
Without a package record, `down` skips Helm namespace checks. It removes computer
resources only when `quota.json` exists; that file is saved before the first
Kubernetes call during computer setup. With neither record, teardown makes no
Kubernetes calls.
See [package operator notes](../package/README.robot.md).
The package installer reads the server Service ClusterIP after Helm creates it.
It writes that IP to the computer ConfigMap before waiting for the first owner.
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
generated directories. Paid providers require the explicit opt-in below.

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

## Memory reads

Startup launches the `memory` ops worker with the projection reader settings. Set
`MEMORY_KEY_DIRECTORY` before startup to pass the existing private directory to both
worker and server. The stack never creates this directory or its revision keys.
Without it, the worker logs one message and exits; it is then excluded from the list
of required running processes, and memory HTTP routes return `503 memory_unavailable`.
With it, startup requires the memory process to stay running like the other workers.

## Daily fresh run

`daily-fresh-run.sh` fetches `origin`, checks out `origin/main` detached in
`~/dev/daily-fresh`, and runs `npm ci` only when `package-lock.json` has changed
since the previous run. It then starts `daily-fresh.sh` from that checkout.
The install script copies this launcher to `~/.opencrane/daily-fresh/run.sh`.

`daily-fresh.sh` claims a secondary id using `claim.sh`, then runs `up.sh --fresh`
with that id. Secondary model services use the local stub. The run makes no paid
model calls. An EXIT trap calls `down.sh --id` with only the id returned by the
claim, after accepting only 1 or 2. A failed startup still reaches that cleanup.
Each invocation replaces an inherited attempt with `nightly-<UTC time>-<UUID>` in
`P4_JOURNEY_ATTEMPT`. It clears inherited real-provider settings, `MODEL_KEY_FILE`
and `DEMO_ALLOWANCE_CENTS` before any child starts. No paid key is read.
The narrow group checks run with the stand-in and never change providers or owners.
A read-only tool fixture includes its action, consequence and safe argument fields.
The core journey selects Allow for that tool and Block for the write tool, using the
saved catalogue revision and review digest. The review must return HTTP 200. A 409
stops the journey; it is never treated as a saved review. The focused regression in
`journey-tool-policy.test.ts` uses the same review validator as the API, without services.
The first and later group sends each wait for HTTP 200, then require the sender’s
message to appear within two seconds. This includes the time taken to apply its saved
row. Their existing receipt rows record `firstDisplayMs` and `laterDisplayMs`.
A failed or unfinished group-chat assertion fails the journey. Before cleanup, nested
receipts and pictures from this attempt are kept under the private failure folder.

If `claim.sh` cannot return an id, the script records `SKIPPED` with the reason
`no free slot` and exits successfully. Every run adds one UTC line to
`~/.opencrane/daily-fresh/ledger.md`. The line records the checked-out source
commit, result, failed step, duration and attempt. On failure, it copies `last-error.log`,
`failure.log`, the last 100 lines of each other process log, and any journey failure
screenshots into a folder named for that attempt before `down.sh` removes the
stack files. Before writing a log, `sanitise-evidence.mjs` replaces known slot
passwords, generated environment secrets, private keys and the supplied
`ZITADEL_KEY_FILE` value with `[REDACTED]`. It also removes URL credentials,
bearer tokens, authorisation headers and values with sensitive setting or JSON field
names. Secret files are read only by the sanitiser. A failed sanitisation writes
only `Log withheld: sanitisation failed.`. It skips `zitadel-*` files. The receipt line names that folder. The
directory is mode 0700; the evidence files and ledger are mode 0600.

The user service is `opencrane-daily-fresh.service`; its timer is
`opencrane-daily-fresh.timer`. The timer runs daily at 03:17 UTC with
`Persistent=false`, so a missed run is not replayed after login. Install or update
both units with `infra/dev-stack/install-daily-fresh-timer.sh`. That script copies
the units to `~/.config/systemd/user/`, reloads the user manager and enables the
timer immediately.

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
For a packaged fresh check, `zitadel-setup.ts --read-only` checks the existing
secondary app and four test users. It creates local settings and copies the
slot's saved credentials, but refuses missing provider resources instead of
creating them. The package runner uses this mode and makes no provider writes.
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
four users named `opencrane2-dev-ci-<id>-<role>`. The roles in the names are
owner, member, without-assistant and wrong-account.
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
The typed integration-row fixture registers a hosted image reference without an
installation request. Its per-call credential contract needs no startup credential.
It seeds discovery, saves the exact tool review through the
Owner API, and records legacy publication. No container starts and no tool is called.
The existing remote watcher selects only remote registrations, so it cannot invalidate
this display fixture. This check does not qualify remote discovery or hosted installation.
`apps/server/test/journey-integration-fixture.test.ts` records the old remote fixture's
publication followed by failed checks, then requires the current fixture to remain Ready
after the real watcher runs. It uses disposable NATS and PostgreSQL services.
Failure exits non-zero. Private logs identify a failed stage without printing
credentials. `status` reports the host processes, Compose and Tailscale service.
The owner's own browser sign-in remains a manual check and is **NOT RUN** by these scripts.

### Organisation browser checks

`journey.ts` calls the groups-only checks in `browser-phase4.ts` and
`browser-group-chat.ts` after the existing
browser checks. Both modules reuse the signed-in owner and member pages. The group
chat check creates a conversation from the To line with two colleagues, checks the
mode before the first message, and sends ordinary messages to each member. It waits
for earlier computer starts to finish, then counts AI, computer and budget events
around those sends. Synthetic colleagues use the existing event fixture and
`personalAssistant: none`; they need no personal computer for group messages.
This leaves room for the demo assistant inside the six-computer slot limit.
It adds a third seeded member and
checks that earlier messages stay hidden from that member. The check also removes a
member, asks another member to leave, and records how quickly each screen clears.
Removal observers start before Remove. Their zero is the browser's removal request event,
which starts before the server can save removal. The receipt records milliseconds for
`removalSent`, `removalAccepted`, `removalSaved`, `accessStreamUpdated`, `liveFeedClosed`,
`pageCleared`, `historyRefused`, `fileRefused` and `ownerList`. The HTTP response and the
saved-event observation stay separate. Saving and updating access are one event append
to `participation-*`; both timings are when the journey reads that saved event.
Page and saved-event observations are upper bounds, with 20 ms polling plus request time.
The live-feed time is the observed close of the connection open when removal is sent;
a previously closed connection cannot satisfy it. A missing observation is `NOT RUN`
and fails the check. Access observations must finish within two seconds of sending.
The Owner list must update within its separate ten-second limit. The removed browser
has a ready conversation WebSocket before removal. The next history and file-list reads
start after the successful response and must return 403.
The file route already returns 403 for a group chat before removal; the receipt records
that baseline. Its later refusal does not qualify revocation of previously readable files.
This people-only chat has no computer viewer or pending approval, so those checks are
not qualified by this journey.
`group-removal-timing.test.ts` uses a fake clock to keep a slow Owner list independent
of the removed page and API reads, and to refuse a page that clears after two seconds.
It also fails an unreadable Owner list. `browser-group-removal.test.ts` checks that a
700 ms response cannot hide a 2,400 ms page clear, and that a replacement connection
must close even when an earlier connection has already closed.
It checks the long-name and no-match picker states, refuses an unauthorised add, and
refuses a people-and-assistant choice without saving a conversation. It stops the server and conversation worker for an offline replay, then restarts both
and checks server health directly. Each health read gets the time left in the two-minute
startup deadline as its abort timeout. Connection failures and HTTP 502, 503 and 504
allow another read. Other HTTP failures stop the journey immediately. Replay must
keep the group mode and participants.

The shared-assistant check adds a model grant to the disposable event store so the
group can create an assistant. The member starts a private session with it. The direct
chat sends one message each way and reads the conversation stream to check message
order. The direct checks count model admission, computer and budget events before and after
the exchange, so they also run with real providers. Both chat checks read again for
up to fifteen seconds when a saved change moves the list (409) or is still applying
(425). Other HTTP failures stop the check; no write is repeated.

The separate full browser check, excluded from nightly and rehearsals, saves the text
`journey-placeholder-not-a-provider-key`. It is a
fake value, never a provider credential. The check confirms that the input clears and
that the text is absent from the page, browser storage, provider events and process
logs. The local server keeps the key in a private folder inside the disposable stack,
outside the event store. Stack cleanup removes that folder. It does not ask the provider
to answer. Each assertion is written to
`docs/process/p4-journey/run-<attempt>.json`; screenshots sit beside this receipt in
`run-<attempt>/`. Set `P4_JOURNEY_ATTEMPT` to keep the two fresh run receipts apart.
The group chat receipt is part of the same JSON file. Its screenshots are saved under
`run-<attempt>/group-chat/` at 1280px and 390px.

The spare stack allows six computer pods and disks, with up to 3 GiB of memory
and 6 GiB of disk requests. The sixth place lets a saved-data repeat start a new
shared assistant computer while keeping the previous run's data.

The ownership transfer check runs only when PR #262 is merged. A development event
gives the signed-in test account the Owner role before the ownership screen opens.
The transfer itself goes through the live review and owner screen. Separate member
disks and browser profiles are not built. A real provider answer needs a paid call;
the check records it as **PAID / NOT RUN** and sends no request.

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
npm run visual:screen-p4-19-signin
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
members are refused organisation history. The organisation-history check follows older pages to find the saved MCP
publication, checking each page for private canaries. Newer membership grants can
fill the first page before this check starts.
The browser waits for **History loaded** on each page before checking for the
publication or an **Older history** button.
Owner/member sessions use real Zitadel
sign-in; the extra member uses a dev-only signed session to test resource authority.
Both views and the refusal screen are checked at 1280px and 390px. Private chat,
query, conversation-id and bearer canaries must be absent from live process and
model/gateway logs. Fresh/repeat screenshots go to `docs/process/p3-19-live/`;
the [audit receipt](../../docs/process/p3-19-audit-evidence.md) records qualification.

## Browser approval qualification

Every journey also configures the credential-free `approval-journey` MCP route
against the local recording stub. Calls use `mcp-name` and `params._meta` with
camelCase version/capability keys, the signed thread id and a stable call id.
It seeds saved tool definitions with matching digests, a fresh five-minute catalogue,
grants and an active tool turn through events. Discovery must leave every tool blocked
and unreviewed. The fixture reads the saved events for the current review revision.
The signed-in owner saves the exact Ask review through
`POST /api/org/integrations/:serverId/review` before publication.
The later integration-list check uses the same path to save Allow for its read tool
and Block for its write tool. The gateway is called with lifecycle credentials.
The stack gives the recording stub a new `MODEL_STUB_MCP_GENERATION` and the saved
catalogue digest at startup. It puts the same generation in the configured MCP route,
with `revisionHeader: 'x-opencrane-mcp-revision'`. The stub checks both values just
before recording the call. Its digest comes from the same saved test definition as
the journey. Missing or changed headers return 409 with no recorded effect. Run the focused check with
`nice -n 10 node --experimental-strip-types --test infra/dev-stack/model-stub.test.ts`.
The signed-in requester sees the 8g card, approves in the browser and retries the tool once.
A refused or ambiguous decision submission uses Check status before a safe retry,
with at most three submissions and three status reads per submission; the journey
records the submission counts. A failed status read never authorises a retry.
The stub must record exactly one call with unchanged bytes and an allowed decision;
a second retry and a denied call must produce no additional upstream effects.
Requested, approved, used (outcome unknown) and denied cards survive reload at
1280px and 390px. Screenshots go to `docs/process/p3-2-live/`.
The approved card says **Approved by you** and **Not used yet**. The journey checks
those words before retrying the tool. A failed approval step saves
`approval-failure-<width>.txt` and `approval-failure-<width>.png` in the selected
stack's private directory before cleanup closes the turn. The text includes the
browser error and the card's accessible names, which screen readers use.
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

`upload-journey.ts` accepts the file-list API's HTTP 425 while the files projection
is applying. It retries within its existing two-minute delivery limit. HTTP 200
still requires exactly one clean upload; an empty list remains a failure.

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
journey creates the `budget-journey` group and `team-budget-journey` shared assistant
through the owner APIs, adds the signed-in member and starts private shared sessions
at both widths. It waits for the membership and assistant receipts to confirm their
read tables and access records before opening sessions.
Plain startup reuses the same creation commands and subjects.
Personal assistants are not valid choices in the spending editor.
The journey restores that exact paying group, assistant and global limits after the
budget browser checks, whether they pass or fail. Audit checks finish before budget
setup and change no ceilings. Cleanup uses the authenticated
budget API rather than loading the Spending page. It waits for the budget table to
catch up before the next step. Monthly test limits are 20,000 cents; the daily global
limit is 5,000 cents. It attempts every scope and reports any failed restoration.

## Lifecycle image-update tests

The lifecycle worker upgrades suspended Sandboxes in place. It reads the checked
cluster template and sends one resource-version-checked update of `spec.podTemplate`.
Admission requires the controller to confirm that the Pod is gone. It checks the
exact new template, the named home PVC volume and unchanged metadata and other
spec fields. The worker has no Sandbox delete or PVC write rights.

`apps/ops/test/lifecycle-k3d.test.ts` requires a claimed secondary `DEV_STACK_ID`
of 1 or 2 and checks that this worktree owns it. It creates and removes only that
slot's computer namespace and its three named admission policies. It builds a
second image digest under a slot-specific tag. It uses disposable PostgreSQL
databases through `PG_TEST_URL`. Run it with the rest of that slot stopped.
The owner namespace and configuration directory must never be used.

## Invitation sign-in requirements

The [acceptance API](../../docs/api/members.md#zitadel-deployment-requirements)
requires self-registration off in the silo's organisation, no external identity
providers that assert verified emails, and only trusted admins setting verified
emails. Emails are not unique in Zitadel. Each app must have
`idTokenUserinfoAssertion=true` so its checked ID token includes email claims.

`zitadel-setup.ts` reads the owner app and the selected secondary app to check
this setting. Setup fails with a clear message if it is missing, false or a string.
The check adds no provider write, does not repair the setting and does not touch
external users or other organisations. Tests use an isolated provider fixture;
they verify that a refusal leaves provider state unchanged.

OpenFGA uses its default limit of 100 tuples per atomic write. A new group chat has
at most 97 people, leaving space for its creator, silo and event receipt.

## Gateway control and approval journey

`MODEL_GATEWAY_CONTROL_PORT` is last in the port list: owner 43004, secondary slots
25112 and 25212. It is never published or forwarded. The gateway admits loopback
sources only on this listener. `MODEL_MCP_ROUTES` is no longer supplied.
The approval journey prints `SKIP approval journey: waits for #45 rows 4, 5 and 14`.
It cannot report PASS through the former seeded startup route.

## Managed model calls

Fresh starts with the dev Owner bootstrap run `provider-setup.ts` after server health
and before `journey.ts`. A five-minute dev-only session represents the bootstrapped
Owner, `jente@elewa.ke`. Setup uses product HTTP routes with the configured Origin:
create OpenAI connection, save random stub credential, check reachability, accept the
quoted model test, enable `modelForTask('chat_turn')` and `gpt-6-luna`, explicitly
select the silo default, drain, then switch on. Every write waits for its receipt.
After enabling models, setup waits up to 30 seconds for `seed-provider-default` to
record the first binding. It then reads that position for the explicit Owner selection.
This avoids racing the scheduled binding; it still makes only one selection write
and refuses any later conflict.
HTTP 425 with `status: access_applying` waits 100 ms and repeats the exact input and
command id, within the request's original 30-second deadline. This applies to reads too.
Malformed or different 425 replies stop setup. A lost reply or HTTP 503 reads the original
command result and never repeats an uncertain write, including when that read is 404.
Other refusals stop startup with only the step and status. A refused fresh setup
needs diagnosis and another fresh start. Product access checks still run on every attempt.
Token-bootstrap qualification (`DEV_OWNER_BOOTSTRAP=0`) skips this setup and the journey.

The server and models share `PROVIDER_SECRETS_DIR`. Startup creates it as the host
user with mode 0700 before either process starts. Secondary models mounts it read-only. Startup copies the pinned gateway binary into
the mounted stack directory, so a host tool symlink can point outside the worktree.
The stub reads a separate mode-0600 file and exposes only credential-match counts at
`/provider-counts`: `managed` and `other`. `/journey-counts` keeps its existing response.
The stub supports model-list and non-streaming verification as well as streamed chat.
Provider rows contain no address; the existing `MODEL_UPSTREAM` selects the local stub.

`modelsEnvironment` removes inherited `MODEL_KEY_FILE` settings. Before recorded
switch-on it supplies the local stub file; afterwards it supplies only shared custody.
The stack restarts models after setup and waits for readiness. Repeat starts read
`managedProviderCallsEnabled` before choosing the environment. Default starts make no paid calls.
The [qualification receipt](../../docs/process/p4-22-managed-dev-stack/receipt.md)
records the single-slot qualification. The provider reached ready and switch-on
was accepted. A later-joining member chatted through the explicit default, with no
legacy key-file setting and only managed credentials counted by the restarted stub.
Free reachability admissions do not count as spending; all other unresolved sends
still block switch-on. Twice-fresh qualification remains NOT RUN for PR 5e.

## Hosted MCP namespace rules

`node infra/dev-stack/mcp-admission.mjs <namespace>` installs separate StatefulSet,
Pod and scale policies with fail-closed image parameters. Apply
`mcp-lifecycle-rbac.yaml` in that namespace for lifecycle rights. The caller must
provision `mcp-approved-images`; the lifecycle identity cannot edit it or any policy.
These files are not installed by `up.sh` yet. Part 8b adds quota, network policies
and secondary startup installation. See the [test contract](../../apps/ops/README.robot.md#hosted-mcp-admission).

Pod admission includes `pods/resize` for hosted tools and computers. Computer Pod
resource requests and limits must match the checked sandbox template. The hosted
admission live file covers both policies in disposable secondary namespaces.

## Opt-in real replies

Set `DEV_REAL_PROVIDER_FILE` to the private OpenAI credential file path when running
`up.sh --id 1 --fresh` or `up.sh --id 2 --fresh` on a claimed slot. Only private setup
reads its value and sends it to the existing custody API. The path is not saved in
stack settings or passed to server/models. The provider is named OpenAI demo.
Models and verification omit `MODEL_UPSTREAM`; they use the production OpenAI route.
After switch-on, models has no `MODEL_KEY_FILE`. The local stub is not started.
Only secondary models mounts the host's `/etc/ssl/certs/ca-certificates.crt` file,
read-only at the same path, so the pinned gateway can verify public HTTPS certificates.
The rest of the host certificate directory is not mounted.
Node uses bundled roots and could connect even when the gateway had no trusted roots.
Missing, empty or invalid files fail with a fixed preparation error.

The owner can use `up.sh --id owner --owner-run --fresh` with the same file-path
setting, after the runbook's fresh-install prerequisites are met. Every owner real
start requires the explicit flag, TTY stdin and no `OPENCRANE_FLEET_TASK` variable.
The guard runs before reading or creating the owner directory. Fleet-marked owner
starts are refused even without a real-provider setting, as are all headless owner
starts. Unmarked interactive owner stand-in starts retain their existing behaviour.
`--owner-run` is refused for secondary ids.
Real owner startup skips the stand-in process; startup and status do not require it.
The owner models process already runs on the host and uses its existing certificate store.
The owner command has not been run live; tests replace system commands in a temporary home.

The Compose test resolves both owner and secondary configuration without starting
containers. It checks the exact certificate source, destination and read-only setting,
and refuses certificate mounts on other services. Startup tests use a temporary home
and replacement system commands. They check real-mode eligibility and saved-mode changes
before setup can run. The secondary models test omits required settings so neither
the stand-in nor the models service can start.

Every child in `daily-fresh.test.ts` receives disposable model and Zitadel key paths.
The isolation test supplies synthetic inherited keys whose values match expected log
text. Reading either key changes that text during sanitisation and fails the test.

Setup still uses the product reachability check, exact consented quote, registry models,
explicit default, drain and switch-on. The initial default-binding read waits through a temporary 503 within its existing
thirty-second deadline. A lost write response permits only a GET of the
original command receipt. Recovery requires the expected operation. An absent or unknown
receipt never causes another POST. Incomplete setup stops; repeat startup cannot silently
create another provider or change modes. Keep the opt-in on ordinary restarts. A fresh
start is required to change between real and stub modes. The nightly unsets the opt-in.

The real journey replaces only the stub chat checks. It uses existing sign-in and later
member setup, then four chat turns: arithmetic with streaming/reload, Stop with partial
text/reload, the member's capital-city answer, and an uploaded supplier quote's total and
delivery date. The PDF goes through the normal malware scan and turn input. Together
with provider verification this requests five paid turns. Real startup seeds a maximum
2,000-cent daily/monthly ceiling. Set `DEMO_ALLOWANCE_CENTS` before startup to use a
smaller approved limit, including provider verification. This is not a shared spending counter.
Run only within the owner's shared daily approval. A failure stops the journey without
resubmitting a turn. The receipt in `docs/process/demo-real-model/` records source SHA,
checks and reservation/charge cents; null charges mean an unresolved hold.

## Demo group seed

`DEV_STACK_ID=1 node --experimental-strip-types infra/dev-stack/demo-seed-run.ts`
reuses the bootstrapped Owner and joined slot member, creates two named groups and
one shared assistant, and prints bookmarks. It uses a five-minute development Owner
session and authenticated HTTP commands only. Command ids and payloads stay fixed.
Private `demo-requests` files prevent resubmission after an unknown result; server
receipts remain the source of truth. Missing people are refused before any writes.
The caller must own the stack directory. Owner use additionally requires `--owner-run`,
TTY stdin and an absent `OPENCRANE_FLEET_TASK` variable. These checks happen before
loading owner configuration. Even an empty fleet marker is refused.

`demo-up.sh` requires an explicit secondary id and `DEV_REAL_PROVIDER_FILE` path.
It claims through `claim.sh`, checks the returned id, sets `COMPUTER_IDLE_MS=14400000`,
runs fresh startup and seeds. A mismatched, owner or invalid claim stops before startup
or cleanup. Once startup is attempted, startup or seed failure calls `down.sh` for that
secondary; success keeps it.
It inherits the full startup journey and makes no claim about three-minute duration.
The [owner runbook](../../docs/process/demo/README.md) keeps owner-mode and fresh-install
qualification gates. The timed rehearsal below adds PDF and ceiling preparation.
The seed does not rename existing members or make cloud identity changes.
Tests use `nice -n 10 node --experimental-strip-types --test infra/dev-stack/demo-*.test.ts`.

The launcher tests record startup and cleanup without starting services. They check
that an existing slot survives a request for the other id, unsafe claims cannot reach
startup or cleanup, seed failure removes only the started secondary, and no synthetic
credential value appears in output. The CLI tests use real configuration and session
code with disposable settings and an HTTP fixture. They check id validation before
configuration loads, worktree ownership and the fixed secondary origins.

## Owner startup and automated journey safety

An authorised owner start uses service health, process and listener checks to report
readiness. It does not invoke `journey.ts`. Automated owner journeys are always refused.
The shell launcher, direct stack journey action, main journey, bootstrap journey,
MCP journey, screenshot journey, repeated live-view journey and package chat scripts refuse the owner id
and any `OPENCRANE_FLEET_TASK` marker before configuration is evaluated.
The main journey checks `DEV_REAL_PROVIDER` against the saved mode before setup;
bootstrap and repeated live-view journeys require the saved stand-in mode.

Real starts save real mode after infrastructure and provider checks. Startup remembers
the previous saved mode before a fresh reset. On failure, SIGINT or SIGTERM it stops
processes and Compose services launched by that attempt, removes any namespaces and
HTTPS handler it created, and restores that mode. It attempts each cleanup step even
if another fails. Existing containers are excluded from cleanup. It keeps the restrictive
model firewall rules. A fresh reset still erases data; restoring the mode cannot undo it.
The [demo guide](../../docs/process/demo/README.md#owner-run-switching-the-real-model-off)
documents stopping services and making a fresh stand-in start.

`stack-start.test.ts` runs the real startup control flow with fake configuration,
processes, service adapters and network calls. It checks readiness, deferred mode saving,
failures after saving and switch-on, and both interruption signals. Previous modes
include absent, `0` and `1`. `journey-refusal.test.ts` records configuration evaluation
and stops before external calls. It checks all automated entry points and detects
removal of the non-start owner flag refusal, duplicate flag check and secondary owner
flag refusal. CI runs both files with the existing Node fixtures. These are local
source checks, not live qualification.

## Timed demo rehearsal

The command prepares and rehearses an owned real secondary:

```sh
DEV_STACK_ID=1 DEMO_ALLOWANCE_CENTS=700 \
node --experimental-strip-types infra/dev-stack/demo-smoke-run.ts
```

Replace 700 with the confirmed remaining daily allowance, including startup and holds;
it must be an integer from 1 to 2000. The company daily and monthly ceilings both
use that value. No group or assistant ceiling changes. Owner and missing ids are refused.

The command signs in separate browser profiles, reuses the group seed and uploads
`fixtures/supplier.pdf` through scanning into a fixed personal chat. The quote says
EUR 1,234.56, delivery 17 November 2026. Request records and original receipts prevent
unknown writes from being repeated. The PDF list must report delivery before warm-up.
Warm-up sends one short question to each of the personal and shared computers.
Preparation and warm-up sit outside the timed checks and still count as paid calls.

Each warm attempt has a 180-second deadline. It checks streaming/reload, PDF facts,
preview/download bytes, Stop/reload, live direct delivery, a shared reply, and company
limit refusal/restore. Restoration is attempted even after failure or timeout.
Two attempts capture both browsers at 1280 and 390 pixels after each step;
the member sends at 390 pixels. Failed steps also attempt to save pictures.
Private timings, screenshots and spending records go under the slot's `demo-smoke/`.
Each run saves both previous company ceilings in its own `saved-ceilings.json` before
changing either. Normal completion, failures, SIGINT and SIGTERM restore them through
the admin API. Signals stop new work and close the browser before restoration. The
file is removed only after the API confirms both restored values. If restoration
cannot finish, the next invocation restores saved files before preparing another run.
Keep the run folders until any unfinished restoration has completed. SIGKILL and a
host outage cannot run cleanup; their saved files need that next invocation.

`spending.json` keeps a starting company budget and budget-stream position. It reads
budget events without appending to the store and matches reservations to message ids
submitted by this run's browser contexts. `turns.json` saves those ids without prompts
or credentials. Each recorded call names its reservation, turn, charged cents and
held cents. Unknown outcomes retain the full hold; confirmed unsent calls show zero
charge and hold. Earlier calls and other users' turns are excluded from run totals.
Company totals remain supporting information. Records describe the last observation;
a still-running turn may create further reservations after that observation. A failed
final read marks the record PARTIAL and retains the last known charges and holds.
`timings.json` is written on failures too, including failed warm-up and interrupted
attempts. A warm-up that was never reached is NOT RUN.

Recording fixtures cover preparation failure after raising 100 cents to 700, both
interrupt signals during the limit step, a failed restore recovered on the next run,
and spending and timings after failed warm-up. Separate fixtures reject a failed
step within 180 seconds and successful steps taking longer than 180 seconds. The CLI
fixture refuses configuration loading to prove the secondary id check runs first.
The command does not claim or remove a stack. Use `claim.sh` before startup and
`down.sh --id` after copying the receipt. Live results are in the demo receipt.
