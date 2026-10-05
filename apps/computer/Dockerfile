ARG COMPUTER_BASE=127.0.0.1:5001/opencrane/s035@sha256:6fe29bfc4455f19601bbca9e3cffa998fed57632484bb3a624a8da69beecee47
FROM node:22.23.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS npm-tools
FROM npm-tools AS launcher-build
RUN sed -i 's|http://deb.debian.org/debian-security|http://snapshot.debian.org/archive/debian-security/20261001T000000Z|; s|http://deb.debian.org/debian$|http://snapshot.debian.org/archive/debian/20261001T000000Z|' /etc/apt/sources.list.d/debian.sources && \
    apt-get -o Acquire::Check-Valid-Until=false update -qq && apt-get install -y --no-install-recommends gcc libc6-dev
COPY tool-user.c /tmp/tool-user.c
RUN gcc -O2 -Wall -Wextra -Werror -o /tool-user /tmp/tool-user.c
# S0.5 includes the pinned S0.1b Codex binary and native seccomp launcher.
FROM ${COMPUTER_BASE} AS runtime
USER root
RUN sed -i 's|http://deb.debian.org/debian-security|http://snapshot.debian.org/archive/debian-security/20261001T000000Z|; s|http://deb.debian.org/debian$|http://snapshot.debian.org/archive/debian/20261001T000000Z|' /etc/apt/sources.list.d/debian.sources
COPY apt.lock /tmp/apt.lock
COPY collect-licences.py /tmp/collect-licences.py
RUN apt-get -o Acquire::Check-Valid-Until=false update -qq && \
    xargs apt-get install -y --no-install-recommends < /tmp/apt.lock && \
    sed 's/20261001T000000Z/20261002T000000Z/g' /etc/apt/sources.list.d/debian.sources > /etc/apt/sources.list.d/inherited.sources && \
    apt-get -o Acquire::Check-Valid-Until=false update -qq && \
    mkdir -p /usr/share/opencrane && \
    python3 /tmp/collect-licences.py apt > /usr/share/opencrane/apt-packages.json && \
    rm -rf /var/lib/apt/lists/* /tmp/apt.lock /tmp/collect-licences.py /etc/apt/sources.list.d/inherited.sources /lifecycle /desktop && \
    find /spike -maxdepth 1 -type f -delete
COPY requirements.lock /tmp/requirements.lock
RUN python3 -m venv /opt/python && /opt/python/bin/pip install --no-compile --no-cache-dir --require-hashes -r /tmp/requirements.lock && \
    rm /tmp/requirements.lock && rm -rf /opt/python/lib/python3.11/site-packages/pip* /opt/python/lib/python3.11/site-packages/setuptools* /opt/python/lib/python3.11/site-packages/pkg_resources
# No installed caller uses lxml.isoschematron; these two stylesheets have no licence.
RUN rm /opt/python/lib/python3.11/site-packages/lxml/isoschematron/resources/xsl/RNG2Schtrn.xsl \
       /opt/python/lib/python3.11/site-packages/lxml/isoschematron/resources/xsl/XSD2Schtrn.xsl
RUN find /opt /usr -type d -name __pycache__ -prune -exec rm -rf {} + && \
    rm -rf /tmp/node-compile-cache /workspace && ln -s /home/agent/workspace /workspace && \
    mkdir -p /run/executor /home/tool
ENV PYTHONDONTWRITEBYTECODE=1 NODE_DISABLE_COMPILE_CACHE=1
WORKDIR /app
COPY runtime-package.json package.json
COPY runtime-package-lock.json package-lock.json
RUN --mount=from=npm-tools,source=/usr/local/lib/node_modules/npm,target=/tmp/npm \
    node /tmp/npm/bin/npm-cli.js ci --omit=dev --ignore-scripts && rm -rf /root/.npm
COPY --from=project LICENSE /app/LICENSE
# Copy only our dependency-free routing entrypoint; no server dependencies enter the image.
COPY --from=project libs/models/package.json /app/libs/models/package.json
COPY --from=project LICENSE /app/libs/models/LICENSE
COPY --from=project libs/models/src/routing.ts /app/libs/models/src/routing.ts
# Node 22 strips TypeScript outside node_modules; use the same link as a workspace install.
RUN mkdir -p /app/node_modules/@opencrane && ln -s ../../libs/models /app/node_modules/@opencrane/models
COPY --from=launcher-build /tool-user /usr/local/bin/tool-user
# Codex starts a pipe connector; only the root supervisor starts the native host.
RUN mkdir -p /usr/local/libexec && \
    mv /spike/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex-code-mode-host /usr/local/libexec/codex-code-mode-host && \
    printf '#!/bin/sh\nexec /usr/local/bin/node --experimental-strip-types /app/src/entrypoint.ts connect-host\n' > /spike/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex-code-mode-host && \
    chmod 0555 /spike/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex-code-mode-host /usr/local/libexec/codex-code-mode-host
COPY src ./src
RUN chmod 0755 /app/src && chmod 0444 /app/src/* && chmod 0555 /usr/local/bin/tool-user
ENV PATH="/opt/python/bin:/usr/local/bin:/usr/bin:/bin"
CMD ["/usr/bin/prlimit", "--core=0:0", "--", "node", "--experimental-strip-types", "/app/src/entrypoint.ts"]
