FROM openfga/openfga:v1.21.0@sha256:2113c664a486b5da8d7a2cdab479e0d4e30639c80fd2c000540f645c1dbc1e55 AS source

# Copy only the static server. The running image has no operating-system packages.
FROM scratch
COPY --from=source /openfga /openfga
USER 1000:1000
ENTRYPOINT ["/openfga"]
