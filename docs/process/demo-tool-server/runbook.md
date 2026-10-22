# Demo tool server: local build and pending public deployment

This is Part of #45, P3-4 PR 7. Public deployment and registration are **NOT RUN**.
Only local tests are authorised now. No secondary stack or paid call is needed.

## Missing inputs

The owner-approved host is this VPS, **178.62.34.187**, with a separate process on port
**18445**. An IP address alone cannot register. Still needed:

- An approved HTTPS DNS hostname, with every A/AAAA answer public and reachable on this VPS.
- Existing trusted hostname certificate-chain and private-key file **paths**, readable only
  as required by the process owner. The values never belong in output, arguments or this file.
- Proof that both the product server and models process can reach that hostname and port.

The saved URL must use HTTPS and a DNS hostname, with no userinfo, query or fragment.
Existing discovery and dispatch check all DNS answers, pin the public address, and verify
TLS trust and hostname. They refuse redirects and sessions. Keep those checks unchanged.
Discovery sends no authentication. HTTP 401/403 means `connection_required`, not permission
to add credentials. Register with `accountMode: none`, with no bearer, company or personal account.
No self-signed production CA, resolver/trust bypass, Funnel, rented host, network/daemon changes
or owner-stack changes are part of this work. Missing reachability stays a blocker.

## PID-owned lifecycle, after the missing inputs are supplied

These are future operator steps, not a deployment receipt. Choose an unused port; do not stop
its current owner. Run from `/home/jente/dev/wt/demo-tool-server` in Bash. The shell records the
PID of the Node process it starts, and stops only that PID. Do not use process-name matching.
A stopped shell loses ownership evidence: do not reuse an old PID file to kill a later process.

```sh
# Set these to approved existing file paths. Never put PEM values here.
export TLS_CERT_PATH=/approved/path/to/fullchain.pem
export TLS_KEY_PATH=/approved/path/to/private-key.pem
export PORT=18445
node --experimental-strip-types apps/demo-mcp/src/main.ts &
demo_pid=$!
trap 'kill -TERM "$demo_pid" 2>/dev/null || true; wait "$demo_pid" || true' EXIT INT TERM
```

Keep this shell open while checking the listener and DNS from the authorised callers.
When finished, stop the process from the same shell:

```sh
kill -TERM "$demo_pid"
wait "$demo_pid"
trap - EXIT INT TERM
```

Startup emits no settings or credentials; failures report only a fixed message.
For local-only checks, leave both TLS settings unset. Loopback HTTP is test-only and cannot
be registered. No public listener was started by this build.

## Later qualification

Once hosting is authorised and reachable, use ordinary product registration, admin review,
publication and access grants. The read tool is intended for Allow and the slot change for Ask.
Declarations alone grant no access. Changes to reviewed definitions must stay held.
Fresh-chat approval and one-send evidence belong to part 8; no journey is drafted here.
Never retry an uncertain write. The effect counter proves only what this live process accepted;
restart resets it and cannot resolve an earlier lost response.
