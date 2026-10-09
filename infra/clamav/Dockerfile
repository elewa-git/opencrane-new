# Keep the offline engine/databases pinned, but exclude the non-OSI UnRAR plug-in.
FROM mirror.gcr.io/clamav/clamav-debian:1.5.2@sha256:14e2e0805c6a5ff6728ea591c05565e0f0954d93e8701919012c3a8c44e20674 AS upstream
RUN rm -f /usr/lib/libclamunrar* /usr/lib/libclamav_rust.a

# Flatten the runtime filesystem so removed libraries are absent from every shipped layer.
FROM scratch
COPY --from=upstream / /
ENTRYPOINT ["/usr/sbin/clamd", "--config-file=/etc/clamav/upload.conf"]
