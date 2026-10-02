FROM node:22.23.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS npm-tools
# S0.5 includes the pinned S0.1b Codex binary and native seccomp launcher.
FROM 127.0.0.1:5001/opencrane/s035@sha256:6fe29bfc4455f19601bbca9e3cffa998fed57632484bb3a624a8da69beecee47 AS runtime
USER root
RUN sed -i 's|http://deb.debian.org/debian-security|http://snapshot.debian.org/archive/debian-security/20261001T000000Z|; s|http://deb.debian.org/debian$|http://snapshot.debian.org/archive/debian/20261001T000000Z|' /etc/apt/sources.list.d/debian.sources
COPY apt.lock /tmp/apt.lock
RUN apt-get -o Acquire::Check-Valid-Until=false update -qq && \
    xargs apt-get install -y --no-install-recommends < /tmp/apt.lock && \
    rm -rf /var/lib/apt/lists/* /tmp/apt.lock /lifecycle /desktop && \
    find /spike -maxdepth 1 -type f -delete
COPY requirements.lock /tmp/requirements.lock
RUN python3 -m venv /opt/python && /opt/python/bin/pip install --no-cache-dir --require-hashes -r /tmp/requirements.lock && \
    rm /tmp/requirements.lock && rm -rf /opt/python/lib/python3.11/site-packages/pip* /opt/python/lib/python3.11/site-packages/setuptools* /opt/python/lib/python3.11/site-packages/pkg_resources
WORKDIR /app
COPY runtime-package.json package.json
COPY runtime-package-lock.json package-lock.json
RUN --mount=from=npm-tools,source=/usr/local/lib/node_modules/npm,target=/tmp/npm \
    node /tmp/npm/bin/npm-cli.js ci --omit=dev --ignore-scripts && rm -rf /root/.npm
COPY src ./src
ENV PATH="/opt/python/bin:/usr/local/bin:/usr/bin:/bin"
CMD ["node", "--experimental-strip-types", "/app/src/entrypoint.ts"]
