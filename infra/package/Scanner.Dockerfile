FROM mirror.gcr.io/clamav/clamav-debian:1.5.2@sha256:24b4b24c303efed21633b29d61096fab4a8a7e158a595149238c7bef7b39873c AS scanner
RUN rm -f /usr/lib/libclamunrar* /usr/lib/libclamav_rust.a && \
    rm -rf /var/lib/clamav && install -d -o clamav -g clamav -m 0755 /var/lib/clamav
COPY --from=signatures / /var/lib/clamav/

# Flatten removed UnRAR bytes out of every shipped layer.
FROM scratch
COPY --from=scanner / /
USER clamav
ENTRYPOINT ["/usr/sbin/clamd"]
CMD ["--config-file=/etc/clamav/package.conf"]
