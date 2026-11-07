FROM node:22.23.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS runner-protection
WORKDIR /app/scripts/private-memory-qualification
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev
COPY scripts/private-memory-qualification .
RUN nice -n 10 gcc -shared -fPIC -Wall -Wextra -Werror -I/usr/local/include/node \
       -o runner-protection.node runner-protection.c

FROM node:22.23.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS native-codex
WORKDIR /native
COPY spikes/s0-1b-proxy-gvisor/package.json spikes/s0-1b-proxy-gvisor/package-lock.json ./
RUN nice -n 10 npm ci --omit=dev --ignore-scripts && \
    cd node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin && \
    echo '1748767b230ebfc3d4ab7e4e254920d0c0ad9691fd8c11f190e7d44511a4a92e  codex' \
      | sha256sum -c - && \
    cd /native/node_modules/@openai/codex/bin && \
    echo '61b0194f3bb6534439c8d26a3ed57d0805f84b884588b761795323eeb92fcf70  codex.js' \
      | sha256sum -c - && \
    test "$(node codex.js --version)" = 'codex-cli 0.159.2'

FROM node:22.23.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS build
WORKDIR /app
COPY . .
RUN nice -n 10 npm ci && nice -n 10 npm run build -w apps/web && nice -n 10 npm prune --omit=dev

FROM node:22.23.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS runtime
WORKDIR /app
COPY --from=build /app /app
COPY --from=runner-protection /app/scripts/private-memory-qualification/runner-protection.node \
  /app/scripts/private-memory-qualification/runner-protection.node
# Leave build tools and unrelated packages out of the running image.
RUN rm -rf /app/apps/computer /app/node_modules/@opencrane/computer \
      /app/node_modules/secure-json-parse/benchmarks /app/node_modules/pino/test \
      /app/apps/server/node_modules/fast-uri/test \
      /app/apps/server/node_modules/json-schema-traverse/spec \
      /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
COPY --from=native-codex /native/node_modules/@openai/codex/bin/codex.js \
  /opt/native/node_modules/@openai/codex/bin/codex.js
COPY --from=native-codex /native/node_modules/@openai/codex/package.json \
  /opt/native/node_modules/@openai/codex/package.json
COPY --from=native-codex /native/node_modules/@openai/codex-linux-x64/package.json \
  /opt/native/node_modules/@openai/codex-linux-x64/package.json
COPY --from=native-codex /native/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex \
  /opt/native/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex
COPY --from=build /app/apps/computer/src/private-codex.ts /app/apps/computer/src/private-codex.ts
COPY --from=build /app/apps/computer/src/codex-config.ts /app/apps/computer/src/codex-config.ts
COPY --from=build /app/apps/computer/src/codex-connection.ts /app/apps/computer/src/codex-connection.ts
COPY --from=build /app/apps/computer/src/http.ts /app/apps/computer/src/http.ts
RUN ln -s /opt/native/node_modules/@openai/codex/bin/codex.js /usr/local/bin/codex
ADD --checksum=sha256:65691ff77eb6fa44c908b77a1082c9f092c3b9733b5cefabec0d1104890e21a8 \
  https://dl.k8s.io/release/v1.37.1/bin/linux/amd64/kubectl /usr/local/bin/kubectl
ADD --checksum=sha256:daca5cda76e8c5ab0c1a75912fecf2d6365095403f810db72029c49d14a37e7b \
  https://github.com/agentgateway/agentgateway/releases/download/v1.5.0/agentgateway-linux-amd64 \
  /usr/local/bin/agentgateway
RUN chmod 755 /usr/local/bin/kubectl /usr/local/bin/agentgateway

# Copy only the cleaned filesystem so deleted files cannot ship in older layers.
FROM scratch
COPY --from=runtime / /
ARG SOURCE_REVISION
LABEL org.opencontainers.image.revision="$SOURCE_REVISION"
ENV NODE_VERSION=22.23.1 YARN_VERSION=1.22.22
WORKDIR /app
USER node
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "--experimental-strip-types", "apps/server/src/main.ts"]
