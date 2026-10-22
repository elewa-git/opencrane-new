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

## Systemd-owned lifecycle, after the missing inputs are supplied

These are future operator steps, not a deployment receipt. Choose an unused port; do not stop
its current owner. Run from `/home/jente/dev/wt/demo-tool-server` in Bash as the process owner.
The transient user unit `opencrane-demo-mcp.service` owns the process. Stopping the unit never
uses a saved numeric PID. No shell signal trap is installed, and the shell may close after
startup. Systemd removes the unit when the process exits, including after startup failure.

The VPS supports user systemd services. Some task shells inherit root's session address;
these settings select the current user's existing session instead. If the bus check fails,
stop here and restore that user's session before starting the service.

```sh
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
systemctl --user list-units --no-pager --no-legend >/dev/null
```

Start the service only after the hostname and certificate paths have been approved:

```sh
# Set these to approved existing file paths. Never put PEM values here.
export TLS_CERT_PATH=/approved/path/to/fullchain.pem
export TLS_KEY_PATH=/approved/path/to/private-key.pem
export PORT=18445
systemd-run --user --unit=opencrane-demo-mcp --collect --service-type=exec \
  --property=Restart=no --working-directory="$PWD" \
  --setenv="PORT=$PORT" --setenv="TLS_CERT_PATH=$TLS_CERT_PATH" \
  --setenv="TLS_KEY_PATH=$TLS_KEY_PATH" \
  "$(command -v node)" --experimental-strip-types apps/demo-mcp/src/main.ts
```

Starting an existing unit refuses rather than replacing its process. A successful start
command confirms that Node launched; the status and authorised reachability checks still
need to confirm that the server is listening. Check status with:

```sh
systemctl --user status opencrane-demo-mcp.service --no-pager
```

Stop with:

```sh
systemctl --user stop opencrane-demo-mcp.service
```

After exit, status or stop may report that the unit is not loaded. There is then no demo
process to stop. Do not fall back to a stored PID or process-name search. The unit does not
restart the server automatically, so an unexpected exit cannot silently reset the fixture.

Startup emits no settings or credentials; failures report only a fixed message.
For local-only checks, omit both TLS `--setenv` options and use `env -u TLS_CERT_PATH
-u TLS_KEY_PATH` before the Node command. This also removes any TLS settings inherited from
the user service manager. Loopback HTTP is test-only and cannot be registered.
No public listener was started by this build.

## Later qualification

Once hosting is authorised and reachable, use ordinary product registration, admin review,
publication and access grants. The read tool is intended for Allow and the slot change for Ask.
Declarations alone grant no access. Changes to reviewed definitions must stay held.
Fresh-chat approval and one-send evidence belong to part 8; no journey is drafted here.
Never retry an uncertain write. The effect counter proves only what this live process accepted;
restart resets it and cannot resolve an earlier lost response.

The `x-opencrane-mcp-revision` header identifies the tool catalogue, not the fixture state.
It refuses calls against changed tool definitions. Two concurrent calls using the same current
revision can both succeed: each changes the fixture once, returning effect counts 1 then 2
on a fresh process. There is no state precondition or protection against repeated calls.
