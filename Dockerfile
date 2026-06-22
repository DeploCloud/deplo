# Deplo control plane  multi-stage build (Bun + Next.js standalone)

# --- Agent: the per-server binary (PLAN Part A / ADR-0006). It now lives in its
# own repo (PixelFederico/deplo-agent) and ships as GitHub Release assets, so the
# image no longer builds it (no Go toolchain) — it DOWNLOADS the latest release
# for the build's target arch and verifies it against the release's checksums.txt
# before it ever ends up in the runtime. The control plane launches this as its
# LOCAL agent (DEPLO_AGENT_BIN below); remote servers fetch the same release via
# the install script. The image thus pins "latest at build time"; new servers
# resolve true-latest at install time (lib/agent/release.ts), and the dashboard's
# agent badge surfaces any resulting drift rather than hiding it.
FROM alpine:3.20 AS agent
ARG AGENT_REPO=PixelFederico/deplo-agent
# TARGETARCH is provided by BuildKit (amd64 / arm64) — map it to the asset name.
ARG TARGETARCH=amd64
RUN apk add --no-cache curl coreutils
RUN set -eu; \
    asset="deplo-agent-linux-${TARGETARCH}"; \
    base="https://github.com/${AGENT_REPO}/releases/latest/download"; \
    echo "Fetching ${asset} from ${AGENT_REPO} latest release..."; \
    curl -fsSL "${base}/${asset}" -o /out-deplo-agent; \
    curl -fsSL "${base}/checksums.txt" -o /checksums.txt; \
    want="$(grep -E "[[:space:]]\*?${asset}\$" /checksums.txt | awk '{print $1}')"; \
    test -n "$want" || { echo "no checksum for ${asset} in checksums.txt" >&2; exit 1; }; \
    got="$(sha256sum /out-deplo-agent | awk '{print $1}')"; \
    [ "$want" = "$got" ] || { echo "agent checksum mismatch: want $want got $got" >&2; exit 1; }; \
    chmod 0755 /out-deplo-agent; \
    mkdir -p /out && mv /out-deplo-agent /out/deplo-agent; \
    echo "agent binary verified ($got)"

FROM oven/bun:1.3 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM oven/bun:1.3 AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN bun run build

# --- Runtime: minimal standalone server ---
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV DEPLO_DATA_DIR=/data
# The control plane launches this binary as the local server agent and dials it
# over mTLS for the deploy path (PLAN Part A). Absent => the control plane falls
# back to the in-process direct-Docker deploy path.
ENV DEPLO_AGENT_BIN=/usr/local/bin/deplo-agent

# Real infrastructure tooling: the control plane shells out to these to clone
# repos, build images and orchestrate containers over the mounted Docker socket.
# tar/unzip extract uploaded code archives (the "upload" deploy source).
RUN apk add --no-cache docker-cli docker-cli-compose git curl bash tar unzip

# node-pty is a native module with NO linux prebuild, so it must be compiled
# from source against THIS runtime (Node 22 + musl). The app build runs under
# Bun and Next's standalone tracer doesn't reliably carry a serverExternalPackage's
# native .node, so we install + build node-pty here and drop it into node_modules
# below. python3/make/g++ are the node-gyp toolchain; removed after the build so
# they don't bloat the final image.
RUN apk add --no-cache --virtual .pty-build python3 make g++ \
 && npm install --no-save --build-from-source node-pty@1.1.0 --prefix /pty-build \
 && apk del .pty-build

# Nixpacks build method: the control plane runs the host `nixpacks` binary to
# generate a Dockerfile (the daemon-free step), then builds it over the socket.
# Other build methods (buildpacks, railpack) run entirely in helper containers.
RUN curl -sSL https://nixpacks.com/install.sh | bash \
 && nixpacks --version

RUN addgroup -g 1001 -S nodejs \
 && adduser -S deplo -u 1001 \
 && mkdir -p /data && chown deplo:nodejs /data

COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# The per-server agent binary (downloaded + checksum-verified in the `agent`
# stage from PixelFederico/deplo-agent's latest release). The control plane
# launches it locally and dials it over mTLS for deploys.
COPY --from=agent /out/deplo-agent /usr/local/bin/deplo-agent

# Replace the standalone tracer's node-pty (JS only — Next doesn't trace the
# native .node) with the runtime-compiled one built above against Node 22/musl,
# which carries build/Release/pty.node. node-addon-api is build-time-only
# (header-only; no runtime require), so it isn't copied. The load check fails the
# build loudly if the native module can't resolve.
RUN rm -rf ./node_modules/node-pty \
 && cp -R /pty-build/node_modules/node-pty ./node_modules/node-pty \
 && node -e "require('node-pty'); console.log('node-pty native loads OK')" \
 && rm -rf /pty-build

# Runs as root: the control plane needs access to the mounted Docker socket to
# build images and orchestrate containers on the host.
EXPOSE 3000
VOLUME ["/data"]
CMD ["node", "server.js"]
