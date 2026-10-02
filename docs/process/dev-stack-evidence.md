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

## P2-2 post-rebase qualification, 2 October 2026

**PASS:** `work/lifecycle` at `df2492d5e4e19723f248c2bf86c98837f33b4a2a`,
on `ocn-dev` with the existing `k3d-ocn` gVisor cluster. The main checkout's
stack was stopped before transferring its ownership marker to
`/home/jente/dev/wt/lifecycle`. Zitadel files and `zitadel.json` were retained.
No branch application or journey failure was found; no code fix was needed.

| Command | Result | Join → Ready | Resume → Ready | Pod replacement |
| --- | --- | --- | --- | --- |
| `infra/dev-stack/up.sh --fresh` | PASS | 11,732 ms | 6,072 ms | Workspace file retained |
| `infra/dev-stack/up.sh` | PASS | 161 ms | 7,674 ms | Workspace file retained |

The repeated join reused the existing Ready computer; its 161 ms measurement
is not a new-computer provisioning time. Both runs passed real Zitadel browser
sign-in/out, organisation and expiry refusals, logout/token boundary checks,
HTTP join, PostgreSQL/OpenFGA/WebSocket delivery, typed integrations and access
refusals, members/MCP replay verification, tailnet HTTPS and listener checks.
Tailscale Serve reported **tailnet only**, with no Funnel enabled.

Additional read-only assertions against the event store, `handler_receipts`
and the computers projection passed after the repeated run:

- Each of `zitadel-owner` and `zitadel-member` had two `member.joined` events
  and two completed `create-assistant` receipts, but only one `assistant.created`
  event, one computer identity across all claims and one Ready projection row.
- The computer IDs matched those observed after the fresh run. The owner's
  generation remained 1; the member's advanced from 2 to 3 after the second
  deliberate Pod deletion. Re-joining did not create a second computer.

| Focused validation | Result |
| --- | --- |
| `npm run lint` | PASS |
| `npm run typecheck` | PASS |
| `npx tsc -p infra/dev-stack/tsconfig.json` | PASS |
| `npx vitest run apps/ops/test/credentials.test.ts` | PASS, 1 test; real NATS and agentgateway |
| `PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres npx vitest run libs/projections/test/computers.test.ts` | PASS, 1 test; real PostgreSQL |

The projection test was initially skipped without `PG_TEST_URL`; the explicit
PostgreSQL run above passed.

### Restore the owner's main stack

Stopped the worktree stack, restored `stack-owner` to
`/home/jente/dev/opencrane-new`, and ran that checkout's `up.sh` at
`ea1f71c7385e7506b17854ca814c4e513328222f`. This first restoration attempt
**FAILED**: the dispatcher correctly rejected the saved lifecycle handler set
with “Dispatcher subscriptions changed; a controlled rebuild is required”.

Recovery used main's existing `infra/dev-stack/up.sh --fresh`: **PASS**.
This rebuilt disposable local stack state while retaining all `zitadel-*`
files and `zitadel.json`; no dispatcher fence was weakened or code changed.
All five main services were verified running from the main checkout, with
the lifecycle-only worker stopped. No Zitadel provisioning changes were made;
browser sign-ins used only organisation `393311211338337681`.

Final plain `infra/dev-stack/up.sh` from the main checkout: **PASS**, including
browser sign-in/out, replay and listener checks. The ownership marker remains
on main and `https://ocn-dev.tail00285e.ts.net/` is serving main code, tailnet only.

**NOT RUN in this qualification:** full test suite, `check:events`, separate web
build/tests, standalone `LIFECYCLE_K3D` suite, independent review, managed-cluster
qualification and owner-device interaction. The scope was the required dev-stack
journey and focused tests plus lint/typecheck. No push or merge was performed.
