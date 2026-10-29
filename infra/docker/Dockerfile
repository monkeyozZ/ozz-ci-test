ARG BOOTSTRAP_IMAGE=node:24.22.1-bookworm-slim
FROM ${BOOTSTRAP_IMAGE} AS toolchain

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install --no-install-recommends -y ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*
COPY infra/docker/download-runtime.mjs /opt/ozz/download-runtime.mjs
RUN node /opt/ozz/download-runtime.mjs node
ENV PATH="/opt/node/bin:${PATH}"
RUN npm install --global pnpm@12.14.0 --allow-scripts=pnpm --no-audit --no-fund \
    && node --version \
    && pnpm --version \
    && test "$(node --version)" = "v24.22.1" \
    && test "$(pnpm --version)" = "12.14.0" \
    && rm -f /usr/local/bin/node /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack
COPY infra/docker/runtime-env.mjs infra/docker/healthcheck.mjs /opt/ozz/

FROM toolchain AS dependencies
WORKDIR /workspace
# ARM64 optional native accelerators may need compilation. These tools stay in
# the build stage; the four delivery images inherit the smaller runtime.
ARG DEBIAN_MIRROR=http://deb.debian.org
RUN sed -i "s|http://deb\.debian\.org|${DEBIAN_MIRROR}|g" /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install --no-install-recommends -y python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
ENV npm_config_nodedir=/opt/node
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/config/package.json ./packages/config/package.json
COPY packages/database/package.json ./packages/database/package.json
COPY packages/control-plane/package.json ./packages/control-plane/package.json
COPY packages/infrastructure/package.json ./packages/infrastructure/package.json
COPY packages/api-client/package.json ./packages/api-client/package.json
COPY apps/api/package.json ./apps/api/package.json
COPY apps/worker/package.json ./apps/worker/package.json
COPY apps/console/package.json ./apps/console/package.json
COPY apps/builder/package.json ./apps/builder/package.json
RUN pnpm install --frozen-lockfile --no-runtime --registry=https://registry.npmjs.org

FROM dependencies AS build
COPY packages ./packages
COPY apps ./apps
COPY infra/docker/package-runtime.mjs /opt/ozz/package-runtime.mjs
RUN pnpm db:generate && pnpm -r --sort build
RUN node /opt/ozz/package-runtime.mjs

FROM toolchain AS api
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
COPY --from=build --chown=node:node /output/api/ ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 CMD ["node", "/opt/ozz/healthcheck.mjs", "http://127.0.0.1:3000/api/health/ready"]
ENTRYPOINT ["node", "/opt/ozz/runtime-env.mjs"]
CMD ["/app/dist/main.js"]

FROM toolchain AS worker
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 WORKER_HEALTH_PORT=3001
COPY --from=build --chown=node:node /output/worker/ ./
USER node
EXPOSE 3001
# Liveness remains healthy during an intentional recovery pause. Readiness and
# queue availability are reported separately at /health/ready and by the API.
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 CMD ["node", "/opt/ozz/healthcheck.mjs", "http://127.0.0.1:3001/health/live"]
ENTRYPOINT ["node", "/opt/ozz/runtime-env.mjs"]
CMD ["/app/dist/main.js"]

FROM toolchain AS migrate
WORKDIR /workspace
ENV NODE_ENV=production
COPY --from=build --chown=node:node /output/migrate/ /workspace/packages/database/
COPY infra/docker/cli-entrypoint.mjs /opt/ozz/cli-entrypoint.mjs
USER node
RUN node /opt/ozz/cli-entrypoint.mjs /workspace/packages/database/node_modules/prisma/build/index.js --version
ENTRYPOINT ["node", "/opt/ozz/runtime-env.mjs"]
CMD ["/opt/ozz/cli-entrypoint.mjs", "/workspace/packages/database/node_modules/prisma/build/index.js", "migrate", "deploy", "--schema", "/workspace/packages/database/prisma/schema.prisma"]

FROM toolchain AS caddy
RUN node /opt/ozz/download-runtime.mjs caddy

FROM toolchain AS console
ENV XDG_CONFIG_HOME=/config XDG_DATA_HOME=/data
COPY --from=caddy /opt/caddy/caddy /usr/local/bin/caddy
COPY --from=build /workspace/apps/console/dist/ /srv/
COPY infra/docker/Caddyfile /etc/caddy/Caddyfile
RUN mkdir -p /data /config && chown node:node /data /config
USER node
EXPOSE 8080 8443 8081
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 CMD ["node", "/opt/ozz/healthcheck.mjs", "http://127.0.0.1:8081/health/live"]
ENTRYPOINT ["caddy"]
CMD ["run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
