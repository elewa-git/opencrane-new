# Local dev stack

On `ocn-dev`, with Node 22, installed workspaces (`npm ci`), Docker Compose,
OpenSSL, `flock`, passwordless `sudo` for Tailscale Serve, and an authenticated
Tailscale daemon:

```sh
infra/dev-stack/up.sh --fresh
infra/dev-stack/journey.sh
infra/dev-stack/status.sh
infra/dev-stack/down.sh
```

`up` always runs the core journey. `--fresh` first stops this stack, deletes its
three Compose volumes, computer namespace and generated service credentials, then provisions
from nothing. The `zitadel-*` files and `zitadel.json` are retained: cloud identities survive fresh installs.
Plain `up` reuses data and running processes; `down` retains data and credentials.
These scripts do not touch `pg-test` or the `ocn` registry/MinIO; on `ocn` they
own only the `opencrane-<silo>` computer namespace.
Run one stack per host. The scripts serialise operations with `flock`.

## Services and identities

Compose pins PostgreSQL 17, NATS 2.15.0, OpenFGA 1.21.0 and the same MinIO image
as `infra/devbox` by digest. Licences are PostgreSQL, Apache-2.0 (NATS/OpenFGA)
and AGPL-3.0 (MinIO), all OSI-approved. No new package dependency is introduced;
the worker adds the existing handlers workspace to the ops package.

All published ports bind to `127.0.0.1`: PostgreSQL 55433, NATS 44222, OpenFGA
48080, MinIO 49000/49001, server 48000 and Angular 44200. Container listeners
are inside the Compose network; no gRPC, metrics or NATS monitoring port is
published. `pg-test` keeps 55432. Override the corresponding `*_PORT` variables
when generating a new stack; see `config.ts`. Clients receive URLs via environment
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

The owner has `ORG_OWNER` in this organisation. OpenCrane product permissions
come separately from invitation/join events and OpenFGA, never OIDC roles.
The app uses code + S256 PKCE and client-secret POST authentication, with redirects
`https://ocn-dev.tail00285e.ts.net/auth/callback` and
`https://ocn-dev.tail00285e.ts.net/` after logout. The server pins the resource-owner
claim to this organisation, requesting `urn:zitadel:iam:user:resourceowner`.

To rerun the setup, with `.keys/.zitadel-key` available locally:

```sh
flock "/tmp/opencrane-dev-stack-$(id -u).lock" \
  node --experimental-strip-types infra/dev-stack/zitadel-setup.ts
```

The script searches by exact organisation name, checks the recorded ID, and
scopes all management requests to that org. It creates missing named resources
and reuses existing ones. It does not rotate an existing client secret or password;
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
normal scripts continue to refuse a foreign owner marker.

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
its pin differs from the real token's org, or its session lasts two seconds.
Only those browser auth requests go to the probe. No other cloud org is accessed.

An explicit diagnostic fallback remains for an unreachable issuer only:

```sh
DEV_STACK_OFFLINE_FALLBACK=1 node --experimental-strip-types infra/dev-stack/journey.ts
```

It checks discovery reachability, uses minted five-minute **dev-only** cookies,
prints **FAIL sign-in** and exits non-zero even if the service checks pass.
`up.sh` and `journey.sh` always use real login; they never silently take this path.

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

Run the repository gates with the existing control database:

```sh
npm run lint
npm run typecheck
npm run check:events
PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres npm test
npm run build -w apps/web
npm run test -w apps/web -- --watch=false
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
