#!/usr/bin/env bash
#
# Deplo installer
# Usage:  curl -fsSL https://raw.githubusercontent.com/IdraDev/deplo/main/install.sh | bash
#
# Installs Docker (if missing), Traefik (automatic HTTPS), a private Postgres,
# and the Deplo control plane. Safe to re-run; secrets persist in /opt/deplo/.env
#
# Override defaults via environment, e.g.:
#   curl -fsSL .../install.sh | DEPLO_DOMAIN=deplo.example.com ACME_EMAIL=you@example.com bash
#
set -euo pipefail

DEPLO_VERSION="${DEPLO_VERSION:-latest}"
DEPLO_DIR="/opt/deplo"
ENV_FILE="$DEPLO_DIR/.env"
DEFAULT_ACME_EMAIL="admin@example.com"

bold() { printf "\n\033[1m%s\033[0m\n" "$1"; }
step() { printf "  \033[36m[..]\033[0m %s\n" "$1"; }
ok()   { printf "  \033[32m[ok]\033[0m %s\n" "$1"; }
err()  { printf "  \033[31m[!!]\033[0m %s\n" "$1" >&2; }

bold "Deplo installer"

if [ "$(id -u)" -ne 0 ]; then
  err "Please run as root (or with sudo)."
  exit 1
fi

for bin in curl openssl; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    err "$bin is required but was not found. Install it and re-run."
    exit 1
  fi
done

# 1. Docker ------------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  step "Installing Docker..."
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
  ok "Docker installed"
else
  ok "Docker already installed ($(docker --version | awk '{print $3}' | tr -d ,))"
fi

# 2. Workspace, secrets + network -------------------------------------------
step "Preparing $DEPLO_DIR and the 'deplo' network..."
mkdir -p "$DEPLO_DIR/traefik" "$DEPLO_DIR/data" "$DEPLO_DIR/acme"
docker network inspect deplo >/dev/null 2>&1 || docker network create deplo
touch "$DEPLO_DIR/acme/acme.json"
chmod 600 "$DEPLO_DIR/acme/acme.json"

# Generate secrets once; reuse them on subsequent runs.
if [ ! -f "$ENV_FILE" ]; then
  umask 077
  {
    echo "DEPLO_VERSION=$DEPLO_VERSION"
    echo "DEPLO_DOMAIN=${DEPLO_DOMAIN:-$(hostname -f 2>/dev/null || echo deplo.local)}"
    echo "ACME_EMAIL=${ACME_EMAIL:-$DEFAULT_ACME_EMAIL}"
    echo "DEPLO_SECRET=$(openssl rand -base64 48 | tr -d '\n')"
    echo "DEPLO_DB_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=\n')"
  } > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
fi
ok "Workspace ready (secrets in $ENV_FILE)"

# 3. Traefik -----------------------------------------------------------------
step "Configuring Traefik reverse proxy + Let's Encrypt..."
cat > "$DEPLO_DIR/traefik/docker-compose.yml" <<'YAML'
services:
  traefik:
    image: traefik:v3.3
    restart: unless-stopped
    command:
      - --providers.docker=true
      - --providers.docker.exposedbydefault=false
      - --providers.docker.network=deplo
      - --entrypoints.web.address=:80
      - --entrypoints.web.http.redirections.entrypoint.to=websecure
      - --entrypoints.web.http.redirections.entrypoint.scheme=https
      - --entrypoints.websecure.address=:443
      - --certificatesresolvers.letsencrypt.acme.httpchallenge=true
      - --certificatesresolvers.letsencrypt.acme.httpchallenge.entrypoint=web
      - --certificatesresolvers.letsencrypt.acme.email=${ACME_EMAIL}
      - --certificatesresolvers.letsencrypt.acme.storage=/acme/acme.json
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - /opt/deplo/acme:/acme
    networks:
      - deplo
networks:
  deplo:
    external: true
YAML
docker compose -f "$DEPLO_DIR/traefik/docker-compose.yml" --env-file "$ENV_FILE" up -d
ok "Traefik running"

# 4. Postgres + Deplo control plane -----------------------------------------
step "Starting Postgres and the Deplo control plane..."
cat > "$DEPLO_DIR/docker-compose.yml" <<'YAML'
services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      - POSTGRES_USER=deplo
      - POSTGRES_PASSWORD=${DEPLO_DB_PASSWORD}
      - POSTGRES_DB=deplo
    volumes:
      - deplo-postgres:/var/lib/postgresql/data
    networks:
      - deplo
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U deplo -d deplo"]
      interval: 10s
      timeout: 5s
      retries: 5

  deplo:
    image: deplo/control-plane:${DEPLO_VERSION}
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      - NODE_ENV=production
      - DEPLO_DATA_DIR=/data
      - DEPLO_SECRET=${DEPLO_SECRET}
      - DEPLO_PUBLIC_URL=https://${DEPLO_DOMAIN}
      - DEPLO_DATABASE_URL=postgres://deplo:${DEPLO_DB_PASSWORD}@postgres:5432/deplo
      - DEPLO_ACME_EMAIL=${ACME_EMAIL}
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /opt/deplo/data:/data
    networks:
      - deplo
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.deplo.rule=Host(`${DEPLO_DOMAIN}`)"
      - "traefik.http.routers.deplo.entrypoints=websecure"
      - "traefik.http.routers.deplo.tls.certresolver=letsencrypt"
      - "traefik.http.services.deplo.loadbalancer.server.port=3000"

volumes:
  deplo-postgres:

networks:
  deplo:
    external: true
YAML
docker compose -f "$DEPLO_DIR/docker-compose.yml" --env-file "$ENV_FILE" up -d
ok "Deplo control plane running"

DEPLO_DOMAIN="$(grep '^DEPLO_DOMAIN=' "$ENV_FILE" | cut -d= -f2-)"
bold "Deplo is installed"
echo ""
echo "  Dashboard:  https://$DEPLO_DOMAIN"
echo "  Data dir:   $DEPLO_DIR"
echo "  Database:   Postgres (private, internal network only)"
echo "  Proxy:      Traefik (ports 80/443, automatic HTTPS)"
echo ""
echo "  Point $DEPLO_DOMAIN at this server's IP, then open the dashboard"
echo "  and finish setup in your browser."
echo ""
