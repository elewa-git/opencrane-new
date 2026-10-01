# OpenCrane 2 "computer" image (spike S0.1b / S0.3 / S0.5 starting point).
#
# One image that holds everything a computer needs: Codex app-server, Chromium (from Playwright) with
# Playwright MCP, KasmVNC (live view and takeover), MarkItDown and poppler for documents, a small
# supervisor, and a health endpoint. It runs as a normal user, keeps its scratch disk in /home/agent,
# and holds no secrets.
#
# Build it with ./build.sh (Cloud Build, no local Docker). Versions below are pinned; licences are in
# LICENCES.md. See README.md for how it is used.

# Debian 12 (bookworm) slim, pinned by digest (tag bookworm-20260918-slim, via Google's Docker Hub mirror).
ARG DEBIAN_IMAGE=mirror.gcr.io/library/debian:bookworm-20260918-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251
ARG NODE_VERSION=22.23.3
ARG NODE_SHA256=df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de
ARG KASMVNC_VERSION=1.5.0
ARG KASMVNC_SHA256=770fd3df51510beecc89666879d82faf411276e68c6e11df612f736b891b5f71
ARG MARKITDOWN_VERSION=0.1.8
ARG TYPESCRIPT_VERSION=5.9.3
ARG TYPES_NODE_VERSION=22.20.4

# Freeze Debian packages, including transitive libraries, to this signed archive.
FROM ${DEBIAN_IMAGE} AS base
RUN sed -i 's#http://deb.debian.org/debian-security#http://snapshot.debian.org/archive/debian-security/20261001T000000Z#; s#http://deb.debian.org/debian#http://snapshot.debian.org/archive/debian/20261001T000000Z#' /etc/apt/sources.list.d/debian.sources \
 && printf 'Acquire::Check-Valid-Until "false";\n' > /etc/apt/apt.conf.d/99snapshot

# ---------------------------------------------------------------------------------------------------
# Stage 1: Node.js from nodejs.org, checked against the published checksum, with the parts we do not need removed.
FROM base AS node-dist
ARG NODE_VERSION
ARG NODE_SHA256
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl xz-utils \
 && rm -rf /var/lib/apt/lists/*
RUN set -eux; \
    curl -fsSLo /tmp/node.tar.xz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz"; \
    echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum -c -; \
    mkdir -p /opt/node; \
    tar -xJf /tmp/node.tar.xz -C /opt/node --strip-components=1; \
    rm -rf /opt/node/include /opt/node/share /opt/node/lib/node_modules/corepack /opt/node/bin/corepack \
           /opt/node/CHANGELOG.md /opt/node/README.md; \
    /opt/node/bin/node --version

# ---------------------------------------------------------------------------------------------------
# Stage 2: compile the bridge and the local forwarding proxy from spike S0.1 (TypeScript to JavaScript).
FROM base AS bridge-build
ARG TYPESCRIPT_VERSION
ARG TYPES_NODE_VERSION
COPY --from=node-dist /opt/node /usr/local
WORKDIR /build
RUN npm install --no-save --no-audit --no-fund "typescript@${TYPESCRIPT_VERSION}" "@types/node@${TYPES_NODE_VERSION}"
COPY s0-1-src/ ./src/
COPY bridge-tsconfig.json ./tsconfig.json
# NodeNext needs the package type before compilation, as well as at runtime.
RUN echo '{"type":"module"}' > package.json \
 && ./node_modules/.bin/tsc -p tsconfig.json \
 && test -f dist/bridge.js && test -f dist/local-proxy.js

# ---------------------------------------------------------------------------------------------------
# Stage 3: npm packages (Codex, Playwright MCP) from the committed lockfile, plus Playwright's Chromium.
FROM base AS npm-deps
COPY --from=node-dist /opt/node /usr/local
WORKDIR /opt/computer
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
# Chromium comes from Playwright so that Playwright MCP and the browser always match. --no-shell skips the
# separate headless-only build; we always run the headed browser on the KasmVNC display.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN ./node_modules/.bin/playwright install chromium --no-shell \
 && find /opt/ms-playwright -maxdepth 1 -mindepth 1 -type d

# ---------------------------------------------------------------------------------------------------
# Stage 4: MarkItDown in its own virtual environment.
FROM base AS pyvenv
ARG MARKITDOWN_VERSION
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv python3-pip \
 && rm -rf /var/lib/apt/lists/*
COPY constraints.txt /tmp/constraints.txt
RUN python3 -m venv /opt/venv \
 && /opt/venv/bin/pip install --no-cache-dir -c /tmp/constraints.txt \
      "markitdown[pdf,docx,pptx,xlsx]==${MARKITDOWN_VERSION}" pip==25.3 setuptools==80.9.0 \
 && /opt/venv/bin/pip freeze > /opt/venv/pip-freeze.txt \
 && find /opt/venv -name '__pycache__' -type d -prune -exec rm -rf {} + \
 && /opt/venv/bin/markitdown --version

# ---------------------------------------------------------------------------------------------------
# Final image.
FROM base
ARG KASMVNC_VERSION
ARG KASMVNC_SHA256
ARG NODE_VERSION
ARG MARKITDOWN_VERSION

# Base tools: supervisor (Debian package, Python), poppler for PDFs, openbox as the small window manager for
# the live-view desktop, xwininfo to see the windows, curl and a basic font. python3 is also what the venv uses.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl supervisor python3 poppler-utils openbox x11-utils fonts-liberation \
 && rm -rf /var/lib/apt/lists/*

# Node, the npm packages and the browser from the earlier stages.
COPY --from=node-dist /opt/node /usr/local
COPY --from=npm-deps /opt/computer /opt/computer
COPY --from=npm-deps /opt/ms-playwright /opt/ms-playwright
COPY --from=pyvenv /opt/venv /opt/venv
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright

# Chromium's libraries and fonts, resolved from the dated Debian archive.
# Remove only Xvfb: removing xfonts packages also removes Openbox through its dependencies.
RUN /opt/computer/node_modules/.bin/playwright install-deps chromium \
 && apt-get purge -y xvfb \
 && apt-get autoremove -y --purge \
 && test -x /usr/bin/openbox \
 && rm -rf /var/lib/apt/lists/*

# KasmVNC (GPL-2.0) from its official release, checked against the published checksum.
RUN set -eux; \
    curl -fsSLo /tmp/kasmvnc.deb "https://github.com/kasmtech/KasmVNC/releases/download/v${KASMVNC_VERSION}/kasmvncserver_bookworm_${KASMVNC_VERSION}_amd64.deb"; \
    echo "${KASMVNC_SHA256}  /tmp/kasmvnc.deb" | sha256sum -c -; \
    apt-get update; \
    apt-get install -y --no-install-recommends /tmp/kasmvnc.deb; \
    rm -rf /tmp/kasmvnc.deb /var/lib/apt/lists/*; \
    test -x /usr/bin/Xvnc && test -d /usr/share/kasmvnc/www

# The non-root user. /home/agent is the scratch disk: in a Pod it is a volume, so nothing the image ships may live there.
RUN useradd --create-home --home-dir /home/agent --uid 1000 --shell /bin/bash agent \
 && mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix

# Our own files. The bridge and local proxy are copied in but NOT started (spike S0.1b starts them).
COPY --from=bridge-build /build/dist/ /opt/computer/spike-s0-1/
COPY bin/ /opt/computer/bin/
COPY supervisord.conf /opt/computer/
COPY health.mjs selftest.mjs tcp-relay.mjs licences.mjs inventory.py /opt/computer/
COPY s0-1-src.sha256 /opt/computer/spike-s0-1/SOURCES.sha256
# The compiled files are ES modules, so Node needs to know that for this folder.
RUN echo '{"type":"module"}' > /opt/computer/spike-s0-1/package.json \
 && chmod +x /opt/computer/bin/* \
 && ln -s /opt/computer/node_modules/.bin/codex /usr/local/bin/codex \
 && ln -s /opt/computer/bin/playwright-mcp /usr/local/bin/playwright-mcp \
 && ln -s /opt/venv/bin/markitdown /usr/local/bin/markitdown \
 && ln -s "$(find /opt/ms-playwright -type f -name chrome -path '*chromium-*' | head -n1)" /usr/local/bin/chromium \
 && test -x /usr/local/bin/chromium \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
 && /opt/venv/bin/python -m pip uninstall -y pip setuptools \
 && /opt/venv/bin/python -c "import importlib.metadata as m; print('\\n'.join(sorted(d.metadata['Name']+'=='+d.version for d in m.distributions())))" > /opt/venv/pip-freeze.txt \
 && mkdir -p /opt/computer/licences \
 && node /opt/computer/licences.mjs > /opt/computer/licences/components.txt \
 && cp /opt/venv/pip-freeze.txt /opt/computer/licences/pip-freeze.txt \
 && dpkg-query -W -f='${Package}\t${Version}\n' > /opt/computer/licences/apt-packages.txt \
 && /opt/venv/bin/python /opt/computer/inventory.py \
 && chown -R agent:agent /home/agent

ENV HOME=/home/agent \
    CODEX_HOME=/home/agent/.codex \
    DISPLAY=:1 \
    LANG=C.UTF-8 \
    NODE_ENV=production \
    NODE_PATH=/opt/computer/node_modules \
    PATH=/opt/computer/bin:/usr/local/bin:/usr/bin:/bin \
    COMPUTER_IMAGE_NODE=${NODE_VERSION} \
    COMPUTER_IMAGE_CODEX=0.159.3 \
    COMPUTER_IMAGE_KASMVNC=${KASMVNC_VERSION} \
    COMPUTER_IMAGE_MARKITDOWN=${MARKITDOWN_VERSION}

LABEL org.opencontainers.image.title="OpenCrane 2 computer image (spike)" \
      org.opencontainers.image.description="Codex app-server, Chromium with Playwright MCP, KasmVNC, MarkItDown, poppler, supervisor and health endpoint" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later (our files); components keep their own licences, see /opt/computer/licences" \
      org.opencontainers.image.source="https://github.com/elewa-git/opencrane-new"

# 8080 health, 6901 KasmVNC (web client and websocket). Codex listens on 127.0.0.1:4500 and Chromium on 127.0.0.1:9222 only.
EXPOSE 8080 6901
USER 1000:1000
WORKDIR /home/agent
ENTRYPOINT ["/opt/computer/bin/entrypoint.sh"]
