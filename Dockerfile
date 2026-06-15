# Deplo control plane  multi-stage build (Bun + Next.js standalone)
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

# Real infrastructure tooling: the control plane shells out to these to clone
# repos, build images and orchestrate containers over the mounted Docker socket.
RUN apk add --no-cache docker-cli docker-cli-compose git curl

RUN addgroup -g 1001 -S nodejs \
 && adduser -S deplo -u 1001 \
 && mkdir -p /data && chown deplo:nodejs /data

COPY --from=builder --chown=deplo:nodejs /app/.next/standalone ./
COPY --from=builder --chown=deplo:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=deplo:nodejs /app/public ./public

USER deplo
EXPOSE 3000
VOLUME ["/data"]
CMD ["node", "server.js"]
