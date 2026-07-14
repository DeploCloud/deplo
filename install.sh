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

# 1b. Docker address pools ---------------------------------------------------
# Docker's DEFAULT pools — 172.17.0.0/12 carved into /16s (15 subnets) plus
# 192.168.0.0/16 carved into /20s (16) — allow ~31 networks on a host, and Deplo
# burns ONE PER APP (every stack gets its own `<app>_default` bridge). An
# untouched host therefore dies on its 32nd deploy with "all predefined address
# pools have been fully subnetted", and no amount of cleanup saves it: the
# networks of RUNNING apps are not garbage. Widening the pool is the only fix.
#
# It happens HERE, before the `deplo` network below or any app has taken a
# subnet, because the change needs a FULL daemon restart (a reload does not load
# pools) — and on a host with nothing running yet, that restart is free. Note the
# restart also re-homes docker0 itself (it is allocated from the pools when `bip`
# is unset), which is harmless on a host where nothing is on the default bridge
# yet, and is a second reason not to do this later.
#
# Two rules, both learned from Coolify shipping this same fix badly (their #3529
# then #9537):
#   1. NEVER hardcode 10.0.0.0/8. It swallows the host's own LAN / VPN / WireGuard
#      and then dockerd refuses to start — the very error we came to prevent.
#      Pick a /13 that overlaps NO route already on the box.
#   2. NEVER clobber the operator's daemon.json. An existing default-address-pools
#      always wins; a file we cannot merge safely is left alone with a warning.
# KEEP IN SYNC with the identical block in install-agent.sh.

# Is the /13 at 10.<$1>.0.0 (second octets $1..$1+7) clear of every 10.x route on
# this host? Pure awk — no python, jq or ipcalc required on the target.
pool_candidate_is_free() {
  printf '%s\n' "$2" | awk -v start="$1" '
    BEGIN { end = start + 7; free = 1 }
    $0 != "" {
      split($0, cidr, "/")
      prefix = (cidr[2] == "") ? 32 : cidr[2] + 0
      split(cidr[1], oct, ".")
      if (oct[1] + 0 != 10) next
      if (prefix <= 8) { free = 0; exit }        # this route owns all of 10/8
      if (prefix >= 16) { lo = oct[2] + 0; hi = lo }
      else {
        span = 1
        for (k = prefix; k < 16; k++) span *= 2  # 2^(16-prefix) second octets
        lo = int((oct[2] + 0) / span) * span
        hi = lo + span - 1
      }
      if (lo <= end && hi >= start) { free = 0; exit }
    }
    END { exit (free ? 0 : 1) }
  '
}

configure_docker_address_pools() {
  CFG=/etc/docker/daemon.json
  SIZE=24

  if [ -f "$CFG" ] && grep -q '"default-address-pools"' "$CFG" 2>/dev/null; then
    ok "Docker address pools already configured — leaving them untouched"
    return 0
  fi

  ROUTES="$(ip -4 route 2>/dev/null | awk '{print $1}' | grep -E '^10\.' || true)"
  BASE=""
  for cand in 200 208 216 224 232 240 248 192; do
    if pool_candidate_is_free "$cand" "$ROUTES"; then
      BASE="10.${cand}.0.0/13"
      break
    fi
  done
  if [ -z "$BASE" ]; then
    err "Every candidate address pool overlaps a route on this host — NOT touching Docker."
    err "This server is capped at ~31 apps until you set default-address-pools in $CFG yourself."
    return 0
  fi

  TMP="$(mktemp)"
  if [ ! -f "$CFG" ]; then
    printf '{\n  "default-address-pools": [\n    { "base": "%s", "size": %s }\n  ]\n}\n' \
      "$BASE" "$SIZE" > "$TMP"
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c 'import json,sys
cfg, base, size = sys.argv[1], sys.argv[2], int(sys.argv[3])
with open(cfg) as f: d = json.load(f)
d["default-address-pools"] = [{"base": base, "size": size}]
sys.stdout.write(json.dumps(d, indent=2) + "\n")' "$CFG" "$BASE" "$SIZE" > "$TMP" 2>/dev/null || {
      err "Could not parse $CFG as JSON — leaving it untouched."
      err "Add manually: \"default-address-pools\": [{\"base\": \"$BASE\", \"size\": $SIZE}]"
      rm -f "$TMP"; return 0
    }
  elif command -v jq >/dev/null 2>&1; then
    jq --arg b "$BASE" --argjson s "$SIZE" \
      '.["default-address-pools"] = [{base: $b, size: $s}]' "$CFG" > "$TMP" 2>/dev/null || {
      err "Could not parse $CFG as JSON — leaving it untouched."
      err "Add manually: \"default-address-pools\": [{\"base\": \"$BASE\", \"size\": $SIZE}]"
      rm -f "$TMP"; return 0
    }
  else
    err "$CFG exists and neither python3 nor jq is available to merge into it safely."
    err "Add manually: \"default-address-pools\": [{\"base\": \"$BASE\", \"size\": $SIZE}]"
    rm -f "$TMP"; return 0
  fi

  # Never hand dockerd a config it will reject: it would fail to come back up.
  if command -v dockerd >/dev/null 2>&1 \
     && ! dockerd --validate --config-file="$TMP" >/dev/null 2>&1; then
    err "The generated Docker config failed validation — leaving $CFG untouched."
    rm -f "$TMP"; return 0
  fi

  RUNNING="$(docker ps -q 2>/dev/null | wc -l | tr -d ' ' || true)"
  [ -f "$CFG" ] && cp "$CFG" "$CFG.deplo-bak"
  mkdir -p /etc/docker
  install -m 0644 "$TMP" "$CFG"
  rm -f "$TMP"

  # An UPDATE run lands here on a live host: never bounce someone's running apps.
  # Pools apply at the next daemon restart; until the operator picks a window,
  # this host keeps its ceiling.
  if [ "${RUNNING:-0}" -gt 0 ]; then
    ok "Address pool $BASE written to $CFG"
    err "Docker is running $RUNNING container(s), so it was NOT restarted."
    err "Apply it in a maintenance window: systemctl restart docker"
    return 0
  fi

  step "Applying Docker address pool $BASE (a /$SIZE per network)..."
  systemctl restart docker >/dev/null 2>&1 || true
  i=0
  until docker info >/dev/null 2>&1; do
    i=$((i + 1)); [ "$i" -ge 15 ] && break
    sleep 1
  done
  if docker info >/dev/null 2>&1; then
    ok "Docker address pool: $BASE, a /$SIZE per app (thousands of apps, not 31)"
  else
    err "Docker did not come back after the address-pool change — rolling back."
    if [ -f "$CFG.deplo-bak" ]; then mv "$CFG.deplo-bak" "$CFG"; else rm -f "$CFG"; fi
    systemctl restart docker >/dev/null 2>&1 || true
    if docker info >/dev/null 2>&1; then
      err "Rolled back — Docker is up again, with the default ~31-network ceiling."
    else
      err "Docker is STILL down. Inspect: journalctl -u docker -n 50"
    fi
  fi
}

configure_docker_address_pools

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
  # priority=1 keeps this Host-only dashboard router a true fallback so any
  # more-specific PathPrefix router on the same host (an installed app's
  # /apps/<slug> route, or a project path override) outranks it — Traefik would
  # otherwise default this router's priority to its rule-string length and
  # shadow the app path.
  DEPLO_EXPOSE="$(printf '    labels:\n      - "traefik.enable=true"\n      - "traefik.http.routers.deplo.rule=Host(`%s`)"\n      - "traefik.http.routers.deplo.entrypoints=websecure"\n      - "traefik.http.routers.deplo.tls.certresolver=letsencrypt"\n      - "traefik.http.routers.deplo.priority=1"\n      - "traefik.http.services.deplo.loadbalancer.server.port=3000"' "$DEPLO_DOMAIN")"
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
      - DEPLO_SERVER_IP=$SERVER_IP
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
echo "  GitHub: connect a repo from Settings > Git. GitHub must be able to"
echo "  reach $PUBLIC_URL for the App callback and webhooks (open the port or"
echo "  use a domain). A real domain is recommended for private-repo deploys."
echo ""
