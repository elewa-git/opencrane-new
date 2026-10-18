FROM nats:2.15.0-alpine@sha256:ac8f88a6494bffc2c2a5289a0ca61cb28a9145c11ba5677cf24265d07f46d8d4 AS source

# Copy only the static server. The running image has no operating-system packages.
FROM scratch
COPY --from=source /usr/local/bin/nats-server /nats-server
USER 1000:1000
ENTRYPOINT ["/nats-server"]
CMD ["-c", "/etc/nats/nats.conf"]
