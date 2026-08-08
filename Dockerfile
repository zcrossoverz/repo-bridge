# repo-bridge — remote deployment image.
#
# This base carries the bridge plus git and ripgrep. It deliberately does NOT
# carry every language toolchain: extend it with what your repositories need
# (see the example at the bottom) rather than shipping a 3 GB image nobody uses
# all of.

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=optional
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production

# git is required; ripgrep makes search fast on large repositories.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ripgrep ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --omit=optional && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY scripts ./scripts

# Never run the bridge as root: it executes project build commands.
RUN useradd --create-home --uid 10001 bridge \
 && mkdir -p /data /workspaces \
 && chown -R bridge:bridge /app /data /workspaces
USER bridge

ENV REPO_BRIDGE_MODE=http \
    REPO_BRIDGE_HOST=0.0.0.0 \
    REPO_BRIDGE_PORT=8848 \
    REPO_BRIDGE_DATA_DIR=/data \
    REPO_BRIDGE_MANAGED_ROOT=/workspaces \
    REPO_BRIDGE_PERMISSION=develop

EXPOSE 8848
VOLUME ["/data", "/workspaces"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.REPO_BRIDGE_PORT||8848)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js", "--http"]

# ── Extending for your stack ─────────────────────────────────────────────────
# Create your own Dockerfile:
#
#   FROM repo-bridge:latest
#   USER root
#   RUN apt-get update && apt-get install -y --no-install-recommends \
#         openjdk-21-jdk-headless maven python3 python3-pip \
#    && rm -rf /var/lib/apt/lists/*
#   USER bridge
#
# The bridge discovers build tooling from the repository, so anything on PATH
# and on the allowlist becomes usable with no further configuration.
