# AiTool — all-in-one AI toolbox. One container runs the CLI server
# (dashboard + local API + usage tracker) and the AI proxy layer (external
# CLIProxyAPI core, pinned in core-version.txt).
#
#   docker build -t aitool:local .
#   docker run -d --name aitool \
#     -p 127.0.0.1:7680:7680 -p 127.0.0.1:8318:8318 \
#     aitool:local
#
# Data persists in two volumes: /root/.tokentracker (usage tracker queue and
# per-tool state) and /root/.aitool (proxy core config, auths, usage records,
# provider-switch presets). The core binary is pre-fetched for the image
# platform and staged at /opt/aitool/cli-proxy-api (outside the data dirs, so
# a mounted volume cannot shadow it); the proxy layer copies it into
# ~/.aitool/proxy/bin on first start via AITOOL_CORE_BIN.

FROM node:22-bookworm-slim

# Reachability: a container-bound 127.0.0.1 can never be reached through a
# published port, so the image binds all interfaces by default. Exposure is
# still controlled by which ports you publish (see docker-compose.yml).
ENV AITOOL_BIND_HOST=0.0.0.0 \
    AITOOL_CORE_BIN=/opt/aitool/cli-proxy-api

WORKDIR /app

# Dependency layers first for caching. Dev deps are needed to build the
# dashboard and are pruned afterwards.
COPY package.json package-lock.json ./
COPY dashboard/package.json dashboard/package-lock.json ./dashboard/
RUN npm ci && npm ci --prefix dashboard

COPY . .
RUN npm run dashboard:build \
    && npm prune --omit=dev \
    && node scripts/fetch-core.cjs \
    && mkdir -p /opt/aitool \
    && cp /root/.aitool/proxy/bin/cli-proxy-api /opt/aitool/cli-proxy-api

# A shared-config server must not register the host AI-CLIs' interactive usage
# hooks (it would write its own $HOME path into the host-shared settings.json,
# breaking the host's Stop hook). Placed after the heavy build steps so toggling
# it never busts the npm/dashboard/core layer cache. See passiveHooksMode().
ENV NODE_ENV=production \
    AITOOL_PASSIVE_HOOKS=1

EXPOSE 7680 8318
VOLUME ["/root/.tokentracker", "/root/.aitool"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "require('node:http').get('http://127.0.0.1:7680/api/health',r=>{r.resume();process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1)).setTimeout(3000,()=>process.exit(1))"

CMD ["node", "bin/tracker.js", "serve"]
