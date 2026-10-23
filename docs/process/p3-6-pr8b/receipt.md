# Hosted tool resource and connection checks

These are historical checks of the original implementation. The
[23 October results](rework.md) cover the current Pod bindings, proxy refusal and cleanup.

20 October 2026. Base: `e3f593bf6`. Test-first commits: `0ef992701` (quota)
and `e864692d6` (connections). The fixture used secondary slot 1, claimed through
`infra/dev-stack/claim.sh` after both secondary slots reported free. It used fresh,
random namespaces on the existing `k3d-ocn` cluster. The owner stack and host
networking were untouched. No new image, dependency or paid model call was used.

The existing computer image was
`sha256:2a0fe2d8c956f0b03d4267c476aa514239697d18ca7473dea6674f22c0e78be6`.
The listeners and TCP probes used its installed Python standard library. Separate
ordinary listener Pods used the hosted security and resource settings, with a
fixture command. They did not receive an admission exception. Admission and quota
tests ran in another disposable namespace with the unchanged admission policies.

PASS — the initial quota test failed because the fifth admitted Pod was accepted.
Adding the quota made it pass. Four unchanged Pods fit. Lowering each total below
one Pod's request or limit refused that unchanged Pod with `exceeded quota`;
restoring the quota admitted it. No admission limit changed. Lifecycle dry-run
patches to quota and policy were forbidden; image parameter permissions also held.

PASS — the initial connection test failed because the wrong Pod could connect.
Earlier Node-based listener attempts failed during fixture setup, including exit
137, and are not policy evidence. Python fixtures fixed that setup failure.
Every listener accepted a local TCP connection before the network checks.

PASS — first full live run: 37/37, starting 11:47:27 UTC, 106.84 seconds.
PASS — second full live run: 37/37, starting 11:49:26 UTC, 128.87 seconds.
The [connection output](connections.txt) records the actual addresses and outcomes.
PASS — repository typecheck, event-catalogue agreement (149 types), and all
438 security-rule tests. Repository lint passed, including knip, documentation,
links, licence checks and `lint:changelog`.
Checks and tests ran under `nice -n 10`; security tests used the same test database
URL shown below.

Command (both runs used `nice -n 10`):

```sh
MCP_HOSTED_K3D=1 DEV_STACK_ID=1 \
PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres \
nice -n 10 npx vitest run apps/ops/test/mcp-hosted-k3d.test.ts --maxWorkers=1
```

The second run adds `--silent=false --reporter=verbose` to record connections.

| Connection | Policy installed | Policy removed | Policy restored |
| --- | --- | --- | --- |
| Named gateway namespace and correct Pod, MCP port | Connected | Not separately probed | Connected |
| Wrong Pod in gateway namespace | Blocked | Connected | Blocked |
| Gateway label in another silo namespace | Blocked | Connected | Blocked |
| Direct computer | Blocked | Connected | Blocked |
| Ordinary server | Blocked | Connected | Blocked |
| Gateway to undeclared MCP port | Blocked | Connected | Blocked |
| Reviewed upstream IP and port | Connected | Not separately probed | Connected |
| Same upstream IP, another port | Blocked | Connected | Blocked |
| Arbitrary destination | Blocked | Connected | Blocked |
| Another silo | Blocked | Connected | Blocked |
| Kubernetes API, TCP 443 | Blocked | Connected | Blocked |
| Metadata, 169.254.169.254:80 | Not separately probed before removal | Connected | Blocked |

Each negative row used a real socket. Removing only its directional policy made
the same connection succeed; restoration blocked it again. The metadata check
would be NOT RUN if its listener were unreachable without the policy. It was
reachable here. No HTTP request or credential was sent to metadata or Kubernetes.
There is no DNS allowance; IPv6 upstream bindings are not supported.

Cleanup checked the UIDs of created namespaces and waited for their deletion.
PASS — all fixture namespaces were deleted, and `down.sh --id 1` released
the slot. Disk space was 76 GiB before testing and 74 GiB afterwards;
the node reported no memory, disk or PID pressure.

PASS — ten invalid upstream bindings were rejected before installation: hostname,
CIDR, loopback, unspecified, link-local, multicast, invalid ports, extra fields
and IPv6. The resource script SHA-256 was
`85a9a9253b465369666a84d5dfb5a23d110ae558c66609f7af9973b745a0c439`.

NOT RUN — full root suite, as requested. Product deployment, general lifecycle
startup, secondary startup installation and hosted dispatch remain unavailable.
These checks qualify the disposable namespace rules, not an application journey.
