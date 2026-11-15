FROM alpine/minio:RELEASE.2025-10-15T17-29-55Z@sha256:cf23643a6cf9ce159c57643ceb88279e431262282428c9e0bf3a7ef1a97e84b4 AS source

# Ship only the static AGPL binary. The Alpine operating system is not included.
FROM scratch
COPY --from=source /usr/local/bin/minio /minio
COPY --from=notices / /usr/share/licenses/opencrane-objects/
USER 1000:1000
ENTRYPOINT ["/minio"]
CMD ["server", "/data", "--address", ":9000", "--console-address", "127.0.0.1:9001"]
