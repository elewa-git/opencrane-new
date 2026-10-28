# Keep the offline engine/databases pinned, but exclude the non-OSI UnRAR plug-in.
FROM mirror.gcr.io/clamav/clamav-debian:1.5.2@sha256:24b4b24c303efed21633b29d61096fab4a8a7e158a595149238c7bef7b39873c AS upstream
RUN rm -f /usr/lib/libclamunrar* /usr/lib/libclamav_rust.a

# Flatten the runtime filesystem so removed libraries are absent from every shipped layer.
FROM scratch
COPY --from=upstream / /
ENTRYPOINT ["/usr/sbin/clamd", "--config-file=/etc/clamav/upload.conf"]
