#!/usr/bin/env bash
#
# Deplo installer / updater
# Usage:  curl -fsSL https://raw.githubusercontent.com/IdraDev/deplo/main/install.sh | bash
#
# By default the dashboard is served over plain HTTP on the server's IP at
# port 3000 (http://<ip>:3000). Pass a real domain to route it through Traefik
# with automatic Let's Encrypt HTTPS instead:
#   curl -fsSL .../install.sh | DEPLO_DOMAIN=deplo.example.com ACME_EMAIL=you@example.com bash
#
# Re-running on a machine that already has Deplo updates it in place (pulls the
# latest image and recreates the containers) without rotating secrets.
#
set -euo pipefail

DEPLO_VERSION="${DEPLO_VERSION:-latest}"
DEPLO_DIR="/opt/deplo"
ENV_FILE="$DEPLO_DIR/.env"
DEFAULT_ACME_EMAIL="admin@example.com"
DEPLO_IMAGE="ghcr.io/idradev/deplo:${DEPLO_VERSION}"

bold() { printf "\n\033[1m%s\033[0m\n" "$1"; }
step() { printf "  \033[36m[..]\033[0m %s\n" "$1"; }
ok()   { printf "  \033[32m[ok]\033[0m %s\n" "$1"; }
err()  { printf "  \033[31m[!!]\033[0m %s\n" "$1" >&2; }

# A routable domain needs a dot and must not be a local/mDNS name.
is_real_domain() {
  case "$1" in
    "" | localhost | *.local | *.localdomain) return 1 ;;
    *.*) return 0 ;;
    *) return 1 ;;
  esac
}

detect_ip() {
  local ip=""
  ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}' | head -n1)"
  [ -z "$ip" ] && ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  [ -z "$ip" ] && ip="127.0.0.1"
  printf '%s' "$ip"
}

# Install vs. update is decided by whether a previous install exists.
MODE="install"
[ -f "$ENV_FILE" ] && MODE="update"

bold "Deplo ${MODE}er"

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

# Compose v2 plugin is required (the script uses `docker compose`).
if ! docker compose version >/dev/null 2>&1; then
  err "Docker Compose v2 (\`docker compose\`) is required but was not found."
  err "Update Docker (it bundles the compose plugin) and re-run."
  exit 1
fi

# 2. Workspace, secrets + network -------------------------------------------
step "Preparing $DEPLO_DIR and the 'deplo' network..."
mkdir -p "$DEPLO_DIR/traefik" "$DEPLO_DIR/data" "$DEPLO_DIR/acme"
docker network inspect deplo >/dev/null 2>&1 || docker network create deplo
touch "$DEPLO_DIR/acme/acme.json"
chmod 600 "$DEPLO_DIR/acme/acme.json"

# Generate secrets once; reuse them on subsequent runs (so updates never rotate).
if [ ! -f "$ENV_FILE" ]; then
  umask 077
  {
    echo "DEPLO_VERSION=$DEPLO_VERSION"
    echo "DEPLO_DOMAIN=${DEPLO_DOMAIN:-}"
    echo "ACME_EMAIL=${ACME_EMAIL:-$DEFAULT_ACME_EMAIL}"
    echo "DEPLO_SECRET=$(openssl rand -base64 48 | tr -d '\n')"
    echo "DEPLO_DB_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=\n')"
  } > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
fi
ok "Workspace ready (secrets in $ENV_FILE)"

# Resolve how the dashboard is exposed.
DEPLO_DOMAIN="$(grep '^DEPLO_DOMAIN=' "$ENV_FILE" | cut -d= -f2-)"
ACME_EMAIL="$(grep '^ACME_EMAIL=' "$ENV_FILE" | cut -d= -f2-)"
SERVER_IP="$(detect_ip)"

if is_real_domain "$DEPLO_DOMAIN"; then
  USE_DOMAIN=true
  PUBLIC_URL="https://$DEPLO_DOMAIN"
  DEPLO_EXPOSE="$(printf '    labels:\n      - "traefik.enable=true"\n      - "traefik.http.routers.deplo.rule=Host(`%s`)"\n      - "traefik.http.routers.deplo.entrypoints=websecure"\n      - "traefik.http.routers.deplo.tls.certresolver=letsencrypt"\n      - "traefik.http.services.deplo.loadbalancer.server.port=3000"' "$DEPLO_DOMAIN")"
else
  USE_DOMAIN=false
  PUBLIC_URL="http://$SERVER_IP:3000"
  DEPLO_EXPOSE="$(printf '    ports:\n      - "3000:3000"')"
fi

# 3. Traefik (always up; routes deployed apps, and the dashboard in domain mode)
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
# Compose-substituted vars are escaped (\${...}); shell-computed values inline.
step "Writing the Deplo stack ($([ "$USE_DOMAIN" = true ] && echo "domain + HTTPS" || echo "http://$SERVER_IP:3000"))..."
cat > "$DEPLO_DIR/docker-compose.yml" <<EOF
services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      - POSTGRES_USER=deplo
      - POSTGRES_PASSWORD=\${DEPLO_DB_PASSWORD}
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
    image: $DEPLO_IMAGE
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      - NODE_ENV=production
      - DEPLO_DATA_DIR=/data
      - DEPLO_SECRET=\${DEPLO_SECRET}
      - DEPLO_PUBLIC_URL=$PUBLIC_URL
      - DEPLO_DATABASE_URL=postgres://deplo:\${DEPLO_DB_PASSWORD}@postgres:5432/deplo
      - DEPLO_ACME_EMAIL=\${ACME_EMAIL}
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /opt/deplo/data:/data
    networks:
      - deplo
$DEPLO_EXPOSE

volumes:
  deplo-postgres:

networks:
  deplo:
    external: true
EOF

# Pull the control-plane image first so a missing/private package (or, on an
# update, the newest image) fails clearly instead of a cryptic compose error.
step "Pulling $DEPLO_IMAGE..."
if ! docker pull "$DEPLO_IMAGE" >/dev/null 2>&1; then
  err "Could not pull $DEPLO_IMAGE."
  err "If the package is private, make it public on GitHub, or authenticate first:"
  err "  echo \$GHCR_TOKEN | docker login ghcr.io -u <user> --password-stdin"
  exit 1
fi

step "Starting Postgres and the Deplo control plane..."
docker compose -f "$DEPLO_DIR/docker-compose.yml" --env-file "$ENV_FILE" up -d
ok "Deplo control plane running"

if [ "$MODE" = update ]; then
  bold "Deplo updated"
else
  bold "Deplo installed"
fi
echo ""
echo "  Dashboard:  $PUBLIC_URL"
echo "  Data dir:   $DEPLO_DIR"
echo "  Database:   Postgres (private, internal network only)"
if [ "$USE_DOMAIN" = true ]; then
  echo "  Proxy:      Traefik (ports 80/443, automatic HTTPS)"
  echo ""
  echo "  Point $DEPLO_DOMAIN at this server's IP, then open the dashboard."
else
  echo "  Proxy:      Traefik (ports 80/443) for deployed apps"
  echo ""
  echo "  Open $PUBLIC_URL in your browser to finish setup."
  echo "  To serve the dashboard over HTTPS on a domain, set DEPLO_DOMAIN in"
  echo "  $ENV_FILE (and ACME_EMAIL) and re-run this script."
fi
echo ""
