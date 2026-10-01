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
three Compose volumes and generated credentials, then provisions from nothing.
Plain `up` reuses data and running processes; `down` retains data and credentials.
These scripts do not touch `pg-test`, the `ocn` cluster or its registry/MinIO.
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
processes use the projection NKey and own the projection database. The dispatcher
uses its own NKey and database; the existing pg-boss handler updates OpenFGA.
OpenFGA uses its own PostgreSQL database. The worker entrypoint is also usable
outside this stack: `npm run worker -w apps/ops -- members|mcp-catalogue|dispatcher`.
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

There is **no OIDC provider yet** (#11). The existing server starts with a reserved
`.invalid` issuer setting and makes no discovery request until sign-in. Real
sign-in therefore remains unavailable. The journey alone mints five-minute
**dev-only test session cookies**, using the existing encrypted session codec;
it never prints or persists cookies or adds a login bypass route. Cookie roles
are empty: authorisation comes from event-driven OpenFGA relations. Bootstrap
invitations use command credentials and are labelled dev-only; this is not the
owner's first-member policy. The owner can open the UI, but cannot sign in yet.

## Qualification

The journey uses running services, never mocks: an HTTP join reaches SQL and
OpenFGA while an authorised WebSocket is subscribed; seeded `mcp.*` events produce
typed admin API rows; anonymous and member access are refused; members and MCP
catalogue replay verify online. It also fetches the web page over tailnet HTTPS.
Each invocation adds unique test members and an MCP row; fresh runs remove them.
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
infra/dev-stack/up.sh --fresh && infra/dev-stack/journey.sh
infra/dev-stack/up.sh --fresh && infra/dev-stack/journey.sh
ss -ltnp
```

Compare listeners with a snapshot from before bring-up: no new `0.0.0.0`, `*`
or `[::]` listener is allowed. Existing host SSH is outside this stack.
See [the evidence receipt](../../docs/process/dev-stack-evidence.md) for results
and conditions not qualified by these local journeys.
