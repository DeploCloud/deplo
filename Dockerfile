# Deplo control plane  multi-stage build (Bun + Next.js standalone)
#
# The per-server agent (DeploCloud/deplo-agent) is NO LONGER bundled in this
# image: the control plane never spawns an in-process local agent. EVERY server -
# the host running Deplo included - installs the agent on its own host via
# install-agent.sh (served from /install-agent.sh, which pins the latest release's
# checksum), bootstraps via call-home, and is dialed over mTLS. So there is no Go
# binary to ship here; the dashboard's agent badge surfaces version drift.

# Base images are pinned by digest (supply chain); dependabot bumps them weekly.
FROM oven/bun:1.3@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS deps
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
FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS builder
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

# The break-glass CLI as one bundled file. The runtime image below has no source
# tree, no bun and no tsx, so `bun run recover` cannot exist there - which left
# every Docker install with no way back in at all.
RUN node scripts/build-recover.mjs

# --- Runtime: minimal standalone server ---
FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS runner
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
COPY --from=builder /app/dist/recover.js ./recover.js
# What `deplo recover` on the host runs, and the name its own usage text prints.
ENV DEPLO_RECOVER_CMD="deplo recover"

# npm ships with the base image and the server never shells out to it (`node
# server.js`). Left installed it contributes its own bundled dependency tree to
# this image's vulnerability surface - tar, sigstore, ip-address, picomatch -
# none of which belong to Deplo and none of which anything here loads.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

# Still runs as root. It no longer holds a Docker socket, so the original reason
# is gone; the `deplo` user above is created and ready, but switching to it needs
# a migration for the /data files existing installs already own as root.
EXPOSE 3000
VOLUME ["/data"]
CMD ["node", "server.js"]
