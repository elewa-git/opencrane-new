# Event log settings

For people, read [README.md](README.md) first.

## Cluster configuration

`cluster.conf` includes `nats.conf` without changing its client TLS or NKey account
policy. The existing single-server entrypoint stays unchanged. Start each peer with
`nats-server -c infra/nats/cluster.conf`. All three peers share the cluster name,
client trust and public role keys. Each has its own server name, store directory,
route listener, advertised address and route certificate/key files.

The existing variables and client permissions are described in
[ADR 0005](../../docs/adr/0005-nats-access.md). These additional variables are required:

| Variable | Meaning |
| --- | --- |
| `NATS_SERVER_NAME` | Unique server name within this cluster. |
| `NATS_CLUSTER_NAME` | Shared cluster name. |
| `NATS_ROUTE_LISTEN` | Private interface and port for incoming routes. |
| `NATS_ROUTE_ADVERTISE` | This peer's private DNS name and route port. |
| `NATS_ROUTE_1`, `NATS_ROUTE_2` | Explicit `nats-route://name:port` addresses of the other two peers. |
| `NATS_ROUTE_CA_FILE` | Mounted public CA certificate for route peers only. |
| `NATS_ROUTE_CERT_FILE` | This peer's mounted route certificate. |
| `NATS_ROUTE_KEY_FILE` | This peer's mounted route private key. |

Each `NATS_STORE_DIR` must be separate. Route DNS names must resolve privately.
Each route certificate needs its peer's DNS name in a subject alternative name
(SAN), plus both `serverAuth` and `clientAuth` usages. The server name identifies a
NATS process; the certificate's DNS name identifies a route address.

NATS checks outgoing server names during TLS negotiation.
`verify_cert_and_check_known_urls` also requires incoming certificates to have a
DNS SAN matching a configured route hostname. It includes mutual TLS verification;
it does not map certificates to client roles. See the
[NATS route authentication implementation](https://github.com/nats-io/nats-server/blob/v2.15.0/server/auth.go)
and [TLS guidance](https://docs.nats.io/learn/security/encryption).

The route CA must issue certificates only to this silo's NATS peers. Do not add the
client CA to its trust file. A valid client certificate and NKey cannot grant server
membership. CA signing keys stay outside NATS processes in the existing secret
store. Settings contain public values or file paths, never private key contents.
Missing trust files prevent startup. Issuance and deployment must supply all required
values; there is no plaintext route fallback or public route default.

## Tests and qualification

`libs/event-store/test/cluster-routes.test.ts` is discovered by root Vitest and CI.
It uses the pinned server from `scripts/fetch-nats.sh` and disposable credentials.
The fixture uses distinct server names, storage folders and loopback ports. All
route addresses use `localhost`, so it needs no DNS or host-network changes.
Monitoring is added only to the test copy and listens on loopback.

With `PG_TEST_URL` pointing to a throwaway PostgreSQL database:

```sh
nice -n 10 npx vitest run libs/event-store/test/cluster-routes.test.ts \
  libs/event-store/test/security.test.ts --maxWorkers=2
```

Each refused route handshake runs against an otherwise connected cluster. Foreign,
expired and wrong-name certificates each change one property. A client-issued
certificate with the correct route name and usages isolates the separate-issuer
rule. Positive checks use real peers and the production event-store adapter.
The fixture removes processes and private files after setup errors and test exits.

This is P5-4 PR 1 source coverage, not P5-4 qualification. Helm wiring, three-node
placement, persistent volumes, rotation and P5-5 failure/rejoin drills remain NOT RUN.
No Kubernetes operation or image pin changes are part of this work.
