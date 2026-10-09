# Rebuild the upload test's base image without the developer's private registry.
# Use the pinned Codex package and KasmVNC checksum; never publish this test image to a silo.
FROM mirror.gcr.io/library/node:22.23.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3
ADD --checksum=sha256:770fd3df51510beecc89666879d82faf411276e68c6e11df612f736b891b5f71 https://github.com/kasmtech/KasmVNC/releases/download/v1.5.0/kasmvncserver_bookworm_1.5.0_amd64.deb /tmp/kasm.deb
RUN sed -i 's|http://deb.debian.org/debian-security|http://snapshot.debian.org/archive/debian-security/20261002T000000Z|; s|http://deb.debian.org/debian$|http://snapshot.debian.org/archive/debian/20261002T000000Z|' /etc/apt/sources.list.d/debian.sources && \
    apt-get -o Acquire::Check-Valid-Until=false update -qq && \
    apt-get install -y --no-install-recommends /tmp/kasm.deb chromium x11-utils xdotool && \
    rm -rf /var/lib/apt/lists/* /tmp/kasm.deb /usr/share/kasmvnc/www/* && \
    printf 'tool:x:1001:1001::/home/tool:/bin/bash\ncodex:x:1000:1000::/home/codex:/bin/bash\ndesktop:x:1002:1002::/home/desktop:/bin/bash\n' >> /etc/passwd && \
    mkdir -p /home/codex /home/tool/.codex /home/desktop /workspace /run/codex && \
    chown -R 1000:1000 /home/codex /run/codex && chmod 700 /home/codex /run/codex && \
    chown -R 1001:1001 /home/tool /workspace && chown 1002:1002 /home/desktop && chmod 700 /home/desktop
WORKDIR /spike
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && ln -s /spike/node_modules/@openai/codex/bin/codex.js /usr/local/bin/codex && \
    rm -rf /root/.npm /usr/local/lib/node_modules /opt/yarn* /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/yarn /usr/local/bin/yarnpkg /usr/local/bin/corepack
