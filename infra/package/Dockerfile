FROM node:22.23.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS build
WORKDIR /app
COPY . .
RUN nice -n 10 npm ci && nice -n 10 npm run build -w apps/web && nice -n 10 npm prune --omit=dev

FROM node:22.23.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS runtime
WORKDIR /app
COPY --from=build /app /app
# Leave build tools and unrelated packages out of the running image.
RUN rm -rf /app/apps/computer /app/node_modules/@opencrane/computer \
      /app/node_modules/secure-json-parse/benchmarks /app/node_modules/pino/test \
      /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
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
