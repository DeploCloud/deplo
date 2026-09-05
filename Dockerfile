# Deplo control plane  multi-stage build (Bun + Next.js standalone)
#
# The per-server agent (DeploCloud/deplo-agent) is NO LONGER bundled in this
# image: the control plane never spawns an in-process local agent. EVERY server -
# the host running Deplo included - installs the agent on its own host via
# install-agent.sh (served from /install-agent.sh, which pins the latest release's
# checksum), bootstraps via call-home, and is dialed over mTLS. So there is no Go
# binary to ship here; the dashboard's agent badge surfaces version drift.

FROM oven/bun:1.3 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Bun installs, NODE builds. `bun run build` segfaulted bun 1.3.14 itself
# ("panic: Segmentation fault at address 0x13CB0", then SIGILL / exit 132) at the
# very end of `next build` - after the route table had already printed, so the
# compile was done and the crash is in bun's own teardown. Deterministic: same
# address on a re-run. Nothing here is bun-specific (the script is a bare
# `next build`, the runtime below is node:22-alpine running `node server.js`), so
# building under the runtime we actually ship on costs nothing and removes a whole
# class of "bun crashed on our tree" from the release path. Keep the deps stage on
# bun - bun.lock is the lockfile, and its node_modules layout is npm-compatible.
# Same debian/glibc family as the bun image, so sharp's prebuild still resolves.
FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# Placeholders, builder stage ONLY - they never reach the runtime image below.
# `next build` collects page data by IMPORTING every route module, and lib/db/pg.ts
# fail-fasts on a missing DEPLO_DATABASE_URL at module load (deliberately: a real
# run with no database is a misconfiguration, not a silent fall-through). That
# import is enough to abort the build with "Failed to collect page data for
# /api/auth/[...all]", which is what has kept every image build since v1.0.0 red.
# Nothing connects during a build - `pg.Pool` is lazy and `getPool()` is only
# reached by a query, so a syntactically valid URL satisfies the check and the
# real values arrive as environment variables at run time.
ENV DEPLO_DATABASE_URL=postgres://build:build@127.0.0.1:5432/build
ENV DEPLO_SECRET=build-time-placeholder-not-a-real-secret
RUN node node_modules/next/dist/bin/next build

# --- Runtime: minimal standalone server ---
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
# A larger young generation halves scavenge GC on a busy panel (measured 4% of CPU).
ENV NODE_OPTIONS=--max-semi-space-size=64
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV DEPLO_DATA_DIR=/data

# git/curl/bash clone repos and fetch releases; tar/unzip extract uploaded code
# archives (the "upload" deploy source).
#
# NO docker-cli / docker-cli-compose any more. They were here to drive a mounted
# /var/run/docker.sock, and that mount is gone (ADR-0006: everything host-coupled
# goes to the server agent over mTLS gRPC, on this host as much as any other).
# Shipping the client without the socket would leave a root-capable tool sitting
# in an internet-facing container for no one to use but an attacker.
RUN apk add --no-cache git curl bash tar unzip

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

# Replace the standalone tracer's node-pty (JS only - Next doesn't trace the
# native .node) with the runtime-compiled one built above against Node 22/musl,
# which carries build/Release/pty.node. node-addon-api is build-time-only
# (header-only; no runtime require), so it isn't copied. The load check fails the
# build loudly if the native module can't resolve.
RUN rm -rf ./node_modules/node-pty \
 && cp -R /pty-build/node_modules/node-pty ./node_modules/node-pty \
 && node -e "require('node-pty'); console.log('node-pty native loads OK')" \
 && rm -rf /pty-build

# npm is a BUILD-time tool here (it compiled node-pty above); the server itself
# is `node server.js` and never shells out to it. Left installed it contributes
# its own bundled dependency tree to this image's vulnerability surface - as of
# node:22-alpine that is tar (critical), sigstore, ip-address and picomatch, none
# of which belong to Deplo and none of which anything here loads.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

# Still runs as root. It no longer holds a Docker socket, so the original reason
# is gone; the `deplo` user above is created and ready, but switching to it needs
# a migration for the /data files existing installs already own as root.
EXPOSE 3000
VOLUME ["/data"]
CMD ["node", "server.js"]
