# Dev stack evidence

Feature #10, spec #7. Qualification on `ocn-dev`, 1 October 2026, branch
`work/dev-stack` from `342b8b4`. No cloud resources or paid calls.

## Architecture exercised

- Digest-pinned PostgreSQL 17, NATS 2.15.0 with the existing mutual TLS/NKey
  configuration, PostgreSQL-backed OpenFGA 1.21.0 and MinIO in Compose.
- Production provisioning, server, two projection processes and pg-boss dispatch
  run on the host. NATS roles are separate; the server reads projections using a
  read-only PostgreSQL role. Dispatch and OpenFGA have separate databases/roles.
- Angular proxies to the server; Tailscale Serve exposes HTTPS to the tailnet.
  Generated secrets stay outside Git with directory 0700 and file 0600 modes.

## Fresh-stack journeys

Both runs used exactly:

```sh
infra/dev-stack/up.sh --fresh && infra/dev-stack/journey.sh
```

`up --fresh` removed the stack's volumes and generated secrets before creating
new services, credentials, databases, event stream, consumer and OpenFGA model.
`up` itself runs the journey, so the explicit second invocation also proves
repeatability on populated state. No projection or authorisation handler was
called directly by the journey: live workers did the work.

| Assertion | Fresh run 1 | Fresh run 2 |
| --- | --- | --- |
| HTTP invitation acceptance appends `member.joined` | PASS | PASS |
| Joined row reaches the members projection | PASS | PASS |
| Dispatcher/pg-boss projects admin/member permission into OpenFGA | PASS | PASS |
| Already-subscribed WebSocket receives the new joined member | PASS | PASS |
| Command-identity `mcp.*` appends produce typed admin integrations rows | PASS | PASS |
| Anonymous and ordinary member integrations requests refused | PASS | PASS |
| `npm run replay -- members --verify` online | PASS | PASS |
| `npm run replay -- mcp-catalogue --verify` online | PASS | PASS |
| Tailnet HTTPS returns the Angular app | PASS | PASS |
| No new wildcard listener | PASS | PASS |
| Explicit second journey exits zero | PASS | PASS |

Bootstrap invitations and five-minute encrypted test cookies are **dev-only**.
Cookie roles are empty; the event-derived OpenFGA admin permission grants access.
This proves the command/projection path, not real provider sign-in.

## Listener and lifecycle checks

Compared `ss -ltnp` before bring-up and after the test suites had finished:

| New listeners | Purpose |
| --- | --- |
| `127.0.0.1:55433` | PostgreSQL |
| `127.0.0.1:44222` | NATS TLS |
| `127.0.0.1:48080` | OpenFGA HTTP |
| `127.0.0.1:49000`, `127.0.0.1:49001` | MinIO API/console |
| `127.0.0.1:48000`, `127.0.0.1:44200` | Server/Angular |
| `100.121.102.47:443`, `[fd7a:115c:a1e0::8129:6631]:443` | Tailscale Serve HTTPS |

**PASS:** no new `0.0.0.0`, `*` or `[::]` listener. Existing SSH on
`0.0.0.0:22` and `[::]:22` is unchanged. `pg-test` still accepts connections on
55432; the existing k3d cluster and registry are untouched. Serve reports
“tailnet only”, with no Funnel configuration.

**PASS:** `status.sh`, two consecutive `down.sh` calls, then two consecutive
plain `up.sh` calls. State survives ordinary restart and the journey still passes.
An unowned non-empty secrets directory is refused without changing its contents.
Generated directory/file modes were checked as 0700/0600.

## Gates

| Gate | Result |
| --- | --- |
| `npm run lint` | PASS; one existing WebSocket function-length warning |
| `npm run typecheck` | PASS, all workspaces |
| `npm run check:events` | PASS, 70 event types |
| `PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres npm test` | PASS, 46 files / 876 tests |
| `npm run build -w apps/web` | PASS; existing component CSS budget warning |
| `npm run test -w apps/web -- --watch=false` | PASS, 3 files / 36 tests |
| `npx tsc -p infra/dev-stack/tsconfig.json` | PASS |
| `shellcheck infra/dev-stack/*.sh` | PASS |
| Fresh-stack journey, twice | PASS |

## Not run

- Zitadel sign-in/out and the owner's first-member bootstrap policy (#11).
- Owner-device browser interaction and visual approval (HTTPS was fetched on the box).
- Helm, CNPG backups, NATS R3/failover, coordinated backup/restore and managed
  cluster qualification (#15 / Phase 5).
- Production secret leases, revocation and certificate renewal.
- MinIO upload/retrieval and computer/model journeys; these are outside this core journey.
- Independent review, as instructed; no push or merge performed.

Daily automation is not installed by this feature. The repeatable daily command
is `infra/dev-stack/up.sh --fresh`; the owner/orchestrator chooses its schedule.
