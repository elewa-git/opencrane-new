#!/bin/sh
# Entry point: prepares the scratch disk (/home/agent), then becomes the supervisor.
set -eu
umask 022
for d in work .codex .config .cache; do mkdir -p "/home/agent/$d"; done
# The X11 socket folder must exist and be world-writable. /tmp can be a fresh volume, so create it if missing.
mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix 2>/dev/null || true
# Written once, the first time this disk is used. It survives process and container restarts, which is
# how we show that /home/agent really is a separate volume and not part of the container's own layer.
[ -f /home/agent/.computer-first-start ] || date -u +%Y-%m-%dT%H:%M:%SZ > /home/agent/.computer-first-start
echo "[entrypoint] $(date -u +%Y-%m-%dT%H:%M:%SZ) uid=$(id -u) first-start=$(cat /home/agent/.computer-first-start) kernel=\"$(cut -c1-70 /proc/version)\""
exec /usr/bin/supervisord -n -c /opt/computer/supervisord.conf
