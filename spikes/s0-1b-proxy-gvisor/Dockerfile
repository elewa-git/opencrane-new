FROM mirror.gcr.io/library/node:22.23.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3
WORKDIR /spike
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && ln -s /spike/node_modules/@openai/codex/bin/codex.js /usr/local/bin/codex
COPY .state/tool-user /usr/local/bin/tool-user
COPY common.mjs computer.mjs services.mjs probe.mjs driver.mjs ./
RUN rm -rf /usr/local/lib/node_modules /opt/yarn* /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/yarn /usr/local/bin/yarnpkg /usr/local/bin/corepack && \
    mkdir -p /home/codex /home/tool/.codex /workspace /run/codex && \
    chown -R 1000:1000 /home/codex /run/codex && chmod 700 /home/codex /run/codex && \
    chown -R 1001:1001 /home/tool /workspace && \
    printf 'tool:x:1001:1001::/home/tool:/bin/bash\ncodex:x:1000:1000::/home/codex:/bin/bash\n' >> /etc/passwd
CMD ["node", "computer.mjs"]
