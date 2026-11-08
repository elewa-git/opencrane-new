ARG COMPUTER_BASE=127.0.0.1:5001/opencrane/s035@sha256:6fe29bfc4455f19601bbca9e3cffa998fed57632484bb3a624a8da69beecee47
ARG COMPUTER_APT_BASE=computer-apt-fallback
FROM mirror.gcr.io/library/node:22.23.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS npm-tools
FROM npm-tools AS launcher-build
# Stop slow package downloads even when a connection stays active.
RUN printf '%s\n' \
    'Acquire::http::Timeout "30";' \
    'Acquire::https::Timeout "30";' \
    'Acquire::Retries "5";' \
    'APT::Update::Error-Mode "any";' \
    > /etc/apt/apt.conf.d/80-opencrane-network
RUN sed -i 's|http://deb.debian.org/debian-security|http://snapshot.debian.org/archive/debian-security/20261001T000000Z|; s|http://deb.debian.org/debian$|http://snapshot.debian.org/archive/debian/20261001T000000Z|' /etc/apt/sources.list.d/debian.sources && \
    timeout -v -k 10s 25m apt-get -o Acquire::Check-Valid-Until=false update -qq && \
    timeout -v -k 10s 25m apt-get install -y --no-install-recommends gcc libc6-dev
COPY tool-user.c /tmp/tool-user.c
RUN gcc -O2 -Wall -Wextra -Werror -o /tool-user /tmp/tool-user.c
FROM launcher-build AS process-protection-build
COPY --from=project scripts/private-memory-qualification/runner-protection.c /tmp/runner-protection.c
RUN gcc -shared -fPIC -Wall -Wextra -Werror -I/usr/local/include/node \
    -o /runner-protection.node /tmp/runner-protection.c
# The pinned base image supplies Codex and the native launcher that applies seccomp.
FROM ${COMPUTER_BASE} AS computer-apt-fallback
USER root
# Stop slow package downloads even when a connection stays active.
RUN printf '%s\n' \
    'Acquire::http::Timeout "30";' \
    'Acquire::https::Timeout "30";' \
    'Acquire::Retries "5";' \
    'APT::Update::Error-Mode "any";' \
    > /etc/apt/apt.conf.d/80-opencrane-network
RUN sed -i 's|http://deb.debian.org/debian-security|http://snapshot.debian.org/archive/debian-security/20261001T000000Z|; s|http://deb.debian.org/debian$|http://snapshot.debian.org/archive/debian/20261001T000000Z|' /etc/apt/sources.list.d/debian.sources
COPY apt.lock /tmp/apt.lock
COPY collect-licences.py /tmp/collect-licences.py
RUN timeout -v -k 10s 25m apt-get -o Acquire::Check-Valid-Until=false update -qq && \
    xargs timeout -v -k 10s 25m apt-get install -y --no-install-recommends < /tmp/apt.lock && \
    sed 's/20261001T000000Z/20261002T000000Z/g' /etc/apt/sources.list.d/debian.sources > /etc/apt/sources.list.d/inherited.sources && \
    timeout -v -k 10s 25m apt-get -o Acquire::Check-Valid-Until=false update -qq && \
    mkdir -p /usr/share/opencrane && \
    python3 /tmp/collect-licences.py apt > /usr/share/opencrane/apt-packages.json && \
    rm -rf /var/lib/apt/lists/* /tmp/apt.lock /tmp/collect-licences.py /etc/apt/sources.list.d/inherited.sources /lifecycle /desktop && \
    find /spike -maxdepth 1 -type f -delete
COPY --from=launcher-build /tool-user /usr/local/bin/tool-user
FROM ${COMPUTER_APT_BASE} AS runtime
COPY --from=project scripts/private-memory-qualification/service-protection.ts \
  /scripts/private-memory-qualification/service-protection.ts
COPY --from=project scripts/private-memory-qualification/runner-protection.ts \
  /scripts/private-memory-qualification/runner-protection.ts
COPY --from=project scripts/private-memory-qualification/protection-failure.ts \
  /scripts/private-memory-qualification/protection-failure.ts
COPY --from=project scripts/private-memory-qualification/private-processes.ts \
  /scripts/private-memory-qualification/private-processes.ts
COPY --from=project scripts/private-memory-qualification/container-probe.ts \
  /scripts/private-memory-qualification/container-probe.ts
COPY --from=project scripts/private-memory-qualification/bridge-check.ts \
  /scripts/private-memory-qualification/bridge-check.ts
COPY --from=process-protection-build /runner-protection.node \
  /scripts/private-memory-qualification/runner-protection.node
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
# Copy shared routing and caller checks without adding server dependencies to the image.
COPY --from=project libs/models/package.json /app/libs/models/package.json
COPY --from=project LICENSE /app/libs/models/LICENSE
COPY --from=project libs/models/src/routing.ts /app/libs/models/src/routing.ts
COPY --from=project libs/models/src/private-callers.ts /app/libs/models/src/private-callers.ts
# Share the report text check without adding schema libraries to the computer.
COPY --from=project libs/events/package.json /app/libs/events/package.json
COPY --from=project LICENSE /app/libs/events/LICENSE
COPY --from=project libs/events/src/tool-call.ts /app/libs/events/src/tool-call.ts
# Node 22 strips TypeScript outside node_modules; use the same link as a workspace install.
RUN mkdir -p /app/node_modules/@opencrane && ln -s ../../libs/models /app/node_modules/@opencrane/models && \
    ln -s ../../libs/events /app/node_modules/@opencrane/events
# Codex starts a pipe connector; only the root supervisor starts the native host.
RUN mkdir -p /usr/local/libexec && \
    mv /spike/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex-code-mode-host /usr/local/libexec/codex-code-mode-host && \
    printf '#!/bin/sh\nexec /usr/bin/env -u NODE_OPTIONS /usr/local/bin/node --disable-sigusr1 --experimental-strip-types /app/src/entrypoint.ts connect-host\n' > /spike/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex-code-mode-host && \
    chmod 0555 /spike/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex-code-mode-host /usr/local/libexec/codex-code-mode-host
COPY src ./src
RUN chmod 0755 /app/src && chmod 0444 /app/src/* && chmod 0555 /usr/local/bin/tool-user
ENV PATH="/opt/python/bin:/usr/local/bin:/usr/bin:/bin"
CMD ["/usr/bin/prlimit", "--core=0:0", "--", "/usr/bin/env", "-u", "NODE_OPTIONS", "/usr/local/bin/node", "--disable-sigusr1", "--experimental-strip-types", "/app/src/entrypoint.ts"]
