FROM 127.0.0.1:5001/opencrane/s01b@sha256:2d2fd2007f581a12f16ccdbabd0cbbab7b9f8c40c2bf292534fe162661f93ac1
RUN --mount=type=bind,source=spikes/s0-5-live-view/.state/kasm.deb,target=/tmp/kasm.deb echo '770fd3df51510beecc89666879d82faf411276e68c6e11df612f736b891b5f71  /tmp/kasm.deb' | sha256sum -c - && \
    apt-get update && apt-get install -y --no-install-recommends /tmp/kasm.deb chromium x11-utils xdotool && \
    rm -rf /var/lib/apt/lists/* /usr/share/kasmvnc/www/* && \
    printf 'desktop:x:1002:1002::/home/desktop:/bin/bash\n' >> /etc/passwd && \
    mkdir -p /home/desktop && chown 1002:1002 /home/desktop && chmod 700 /home/desktop
COPY spikes/s0-1b-proxy-gvisor/services.mjs /spike/services.mjs
COPY spikes/s0-3-warm-pool/boot.mjs spikes/s0-3-warm-pool/browser.mjs spikes/s0-3-warm-pool/site.mjs /lifecycle/
COPY spikes/s0-5-live-view/desktop.mjs /desktop/
CMD ["node", "/lifecycle/boot.mjs"]
