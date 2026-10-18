# FLOOR360 takeoff-runner: the auto-takeoff worker for the DGX Spark
# (README.md). CPU only. It never runs docker, never touches another
# container, and asks for no GPU: run it WITHOUT --gpus.
#
# Build from the repository ROOT (the engine in mcp/ bundles web/src/lib):
#   docker build -f floor360/takeoff-runner/Dockerfile \
#     --build-arg RUNNER_BUILD_SHA=$(git rev-parse HEAD) -t takeoff-runner:$(git rev-parse --short HEAD) .

# ---- build: the MCP engine (same build as mcp/Dockerfile) and the runner ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY . .
WORKDIR /app/mcp
RUN npm ci && npm run build
WORKDIR /app/floor360/takeoff-runner
RUN npm ci && npm run build

# ---- runtime: production dependencies and the two bundles only ----
FROM node:22-bookworm-slim AS runtime
ARG RUNNER_BUILD_SHA=""
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/mcp/package.json /app/mcp/package-lock.json mcp/
RUN cd mcp && npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/mcp/dist mcp/dist

COPY --from=build /app/floor360/takeoff-runner/package.json /app/floor360/takeoff-runner/package-lock.json runner/
RUN cd runner && npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/floor360/takeoff-runner/dist runner/dist

RUN mkdir -p /var/lib/takeoff-runner && chown node:node /var/lib/takeoff-runner

# The container runs with --network host (README.md), so the API binds the
# host's loopback only. Never the wildcard address: under the host network
# that would be every host interface.
ENV RUNNER_HOST=127.0.0.1 \
    RUNNER_PORT=8014 \
    RUNNER_DATA_DIR=/var/lib/takeoff-runner \
    RUNNER_MCP_ENTRY=/app/mcp/dist/server.js \
    RUNNER_BUILD_SHA=${RUNNER_BUILD_SHA}

USER node
EXPOSE 8014
HEALTHCHECK --interval=60s --timeout=5s --start-period=20s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.RUNNER_PORT || 8014) + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
# nice 10: the takeoff engine (a child of this process) yields CPU to everything else on the box
CMD ["nice", "-n", "10", "node", "runner/dist/main.js"]
