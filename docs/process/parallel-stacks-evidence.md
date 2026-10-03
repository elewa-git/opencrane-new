# Parallel dev-stack qualification — 3 October 2026

Source: `work/parallel-stacks`, base `ed21e0b42a7930401aedb48d4cbfe7aeadd00901`
plus the change containing this receipt. Host: `ocn-dev`, eight cores, 16 GiB RAM,
Node 22.23.3, existing k3d `ocn`. Both secondary installs are fresh and use the
same worktree with ids `1` and `2`. No paid model provider is used.

Private run artefacts are under `/tmp/parallel-stacks-evidence/` on the dev box.
They include command logs, concurrency timestamps, credential-isolation booleans,
owner configuration/process fingerprints and five-second HTTPS availability samples.
Credential values are never printed or committed. Secondary screenshots are copied
there before teardown; generated stack directories are removed by `down --id`.

## Commands and results

| Check | Result |
| --- | --- |
| Clean `npm ci` | PASS |
| `npm run lint` | PASS |
| `npm run typecheck` | PASS |
| `PG_TEST_URL=… npm test` | PASS: 65 files, 1,028 tests; two opt-in files / ten tests skipped |
| `npm run check:events` | PASS |
| `npm run build -w apps/web` | PASS; existing CSS budget warning |
| `npm run test -w apps/web -- --watch=false` | PASS: six files, 43 tests |
| `npx tsc -p infra/dev-stack/tsconfig.json` | PASS |
| `shellcheck infra/dev-stack/*.sh` | PASS |
| Concurrent fresh core journeys, ids 1 and 2 | PASS: 446.0 s / 436.2 s; 20 PASS checks each |
| Owner HTTPS throughout guarded qualification | PASS: 173 probes, zero failures; fingerprints unchanged |
| Selected teardown, then complete secondary cleanup | PASS: stack 2 healthy after down 1; both fully removed |
| Staged secret scan, including local credential files | PASS |

Each concurrent bring-up runs `infra/dev-stack/up.sh --id <id> --fresh`, with
`ZITADEL_KEY_FILE` naming the existing local PAT file. The shell commands execute
concurrently, and `up` itself invokes the existing full core journey. This covers
real Zitadel sign-in and sign-out, organisation/expiry/CSRF refusals, streamed chat
and Stop at both viewport sizes, join → projections/OpenFGA/WebSocket, computer
suspend/resume and Pod replacement with disk retention, admin permission refusals
and members/MCP replay verification. No offline sign-in fallback is enabled.

The guarded window was **12:14:27–12:29:03 UTC**. The owner’s ownership marker,
settings, credentials, PID records, Compose container IDs and Serve configuration
all matched their starting fingerprints. The guard and monitor were released after
cleanup. No secondary directories, containers, volumes, Compose networks,
Kubernetes namespaces/admission policies or port listeners remained. A resource
sample with both journeys active showed **5,266 MiB host memory available**;
this is one measured sample, not a worst-case capacity guarantee.

## Isolation and recovery evidence

- `claim.sh` returned `1`, then `2`, then exited non-zero. Claims survived failed
  starts. After teardown, simultaneous claims returned distinct ids `1` and `2`;
  a third concurrent slot was refused, then both claims were released. A foreign worktree ownership marker was refused without mutation.
- An occupied port caused startup to fail before any Compose container started.
  On the final port block, a foreign IPv6 listener was refused while all existing
  stack processes and containers were retained.
- Each namespace’s lifecycle token could create its own SandboxClaims and was
  refused in the other secondary namespace.
- NATS CA and all role seeds, PostgreSQL role passwords (including OpenFGA), MinIO,
  session settings and lifecycle keys differed across both secondaries and owner.
- All 22 secondary host listeners were `127.0.0.1`; neither secondary touched
  Tailscale Serve or the owner’s model firewall. The model containers use the
  already-pinned Node runtime image and private k3d relay addresses.
- The existing shared OIDC app contains exactly the owner origin and
  `http://127.0.0.1:25106` / `http://127.0.0.1:25206` callbacks and logout redirects.
  It remains in organisation `393311211338337681`. No other organisation, users,
  grants or instance settings were changed. Experimental redirects added during
  this task were removed through the same scoped setup script.

## Failures retained, then corrected

The original command rejected secondary ids; that was the initial red check.
The first live attempt failed the existing partial-text Stop assertion under
concurrent load. A two-second delta interval remained timing-sensitive. The final
secondary stub pauses after its first delta for the cancellation fixture prompt,
ending the pause when cancelled; the real UI/gateway/Codex cancellation path and
partial-text assertion remain in use. Other replies and the owner stub retain the
original 500 ms interval.

An early port block at 45100/45200 collided with an outgoing Kubernetes connection:
`ss` showed local port 45106 in TIME-WAIT against the Kubernetes API port 6550.
The final blocks 25100/25200 are below the host’s 32768–60999 ephemeral range.
Secondary readiness waits allow 90 seconds under concurrent load; the owner keeps
30 seconds. Overall secondary journey timeout is ten minutes.

Other fleet work restarted the owner, transferred its marker to the main checkout
and stopped Serve during early attempts. Those samples are retained and are not
claimed as continuous availability. The final qualification waits for a healthy
owner, then holds its existing lifecycle lock until both secondaries are removed.
It never starts, stops or takes over the owner. Fingerprints and availability are
compared only within that explicitly recorded window.

Two independent source-review passes found and resolved a secondary disk-quota
mismatch: the dispatcher now requests 1 GiB per computer, leaving the owner default
unchanged. Final live fixes are described above. This is local dev-stack
qualification, not production capacity, R3, failover or disaster-recovery evidence.
The documented ceiling is the stable owner plus two secondary journey stacks.
