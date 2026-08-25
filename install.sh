#!/usr/bin/env bash
#
# Deplo installer / updater
# Usage:  curl -fsSL https://raw.githubusercontent.com/DeploCloud/deplo/main/install.sh | bash
#
# The dashboard ALWAYS answers on the server's IP at port 3000
# (http://<ip>:3000) - that address is the way back in when a domain, a
# certificate or the proxy is what broke. Pass a real domain to route it through
# Traefik with automatic Let's Encrypt HTTPS as well:
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
DEPLO_IMAGE="ghcr.io/deplocloud/deplo:${DEPLO_VERSION}"

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

# 1a. git --------------------------------------------------------------------
# The agent clones repositories with the HOST's git. Without it every app that
# deploys from a repo fails with `exec: "git": executable file not found`, and the
# only way out would be an SSH session - which is the thing Deplo exists to avoid.
ensure_git() {
  command -v git >/dev/null 2>&1 && { ok "git already installed"; return; }
  step "Installing git..."
  # `|| true`: a package manager that refuses is a warning below, never the end of
  # an install that has already put Docker on this machine.
  {
    if command -v apt-get >/dev/null 2>&1; then
      DEBIAN_FRONTEND=noninteractive apt-get update -qq \
        && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git
    elif command -v dnf >/dev/null 2>&1; then dnf install -y -q git
    elif command -v yum >/dev/null 2>&1; then yum install -y -q git
    elif command -v zypper >/dev/null 2>&1; then zypper --non-interactive install -y git
    elif command -v pacman >/dev/null 2>&1; then pacman -Sy --noconfirm git
    elif command -v apk >/dev/null 2>&1; then apk add --no-cache git
    fi
  } || true
  if command -v git >/dev/null 2>&1; then
    ok "git installed"
  else
    err "Could not install git. Apps that deploy from a repository will not build"
    err "until it is there: install it with this system's package manager."
  fi
}

ensure_git

# 1b. Docker address pools ---------------------------------------------------
# Docker's default pools allow ~31 networks and Deplo burns one PER APP, so an
# untouched host dies on its 32nd deploy. Must run before any network exists:
# only a full daemon restart loads new pools. KEEP IN SYNC with install-agent.sh.
#   1. NEVER hardcode 10.0.0.0/8 - it swallows the host's own LAN/VPN and dockerd
#      then refuses to start. Pick a /13 overlapping NO route already on the box.
#   2. NEVER clobber the operator's daemon.json: an existing pool setting wins.

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

# The token that lets THIS machine enroll itself as a server (agent 0). Appended
# rather than written in the block above so an instance installed before host
# enrollment existed gets one by re-running this script - which is also the
# documented repair when the enrollment at the end of this script fails.
# Deplo reads it from its environment and arms a one-time bootstrap on the server
# row; the agent installer below presents the same token to claim it.
if ! grep -q '^DEPLO_HOST_BOOTSTRAP_TOKEN=' "$ENV_FILE"; then
  umask 077
  echo "DEPLO_HOST_BOOTSTRAP_TOKEN=$(openssl rand -base64 32 | tr -d '/+=\n')" >> "$ENV_FILE"
fi
HOST_TOKEN="$(grep '^DEPLO_HOST_BOOTSTRAP_TOKEN=' "$ENV_FILE" | cut -d= -f2-)"
# This box's own name, for the server card. Read here because Deplo runs in a
# container, where `hostname` answers with a random container id.
HOST_NAME="$(hostname 2>/dev/null || cat /proc/sys/kernel/hostname 2>/dev/null || echo "")"
ok "Workspace ready (secrets in $ENV_FILE)"

# Resolve how the dashboard is exposed.
DEPLO_DOMAIN="$(grep '^DEPLO_DOMAIN=' "$ENV_FILE" | cut -d= -f2-)"
ACME_EMAIL="$(grep '^ACME_EMAIL=' "$ENV_FILE" | cut -d= -f2-)"
SERVER_IP="$(detect_ip)"

# The panel ALWAYS publishes :3000 on the host, domain or no domain, and this is
# not an oversight to tidy up later: http://$SERVER_IP:3000 is the way back into
# a panel whose domain stopped working - DNS moved, the certificate expired, the
# proxy is down - and deplo cannot rewrite this file once it is running, so a
# port left unpublished here can never be published from the panel afterwards.
# The only way back would be an SSH session, which is the trip deplo exists to
# remove. Settings, Deplo shows it as the panel's IP address.
DEPLO_EXPOSE="$(printf '    ports:\n      - "3000:3000"')"

# The panel's own route is a Traefik FILE-provider config, not labels on this
# container - and that difference is the whole point. A container's compose file
# belongs to this installer and no agent RPC can rewrite it, so a panel published
# by labels can never be changed from the panel: not its address, not whether it
# orders a certificate. A dynamic-config file is something Deplo is already
# allowed to write - it is how custom certificates are installed.
#
# KEEP IN SYNC with `withPanelRoute` in lib/deploy/traefik-stack.ts, which reads
# and rewrites exactly this shape. `priority: 1` keeps this Host-only router a
# true fallback so any more-specific PathPrefix router on the same host (an app's
# path override, or the reserved /plugins/<slug> route) outranks it - Traefik
# would otherwise default it to its rule-string length and shadow them.
if is_real_domain "$DEPLO_DOMAIN"; then
  USE_DOMAIN=true
  PUBLIC_URL="https://$DEPLO_DOMAIN"
  # Traefik reaches the panel over the shared `deplo` network at the service's
  # own name and the route lives in the file below; the published port above is
  # the panel's IP address, not how the domain is served.
  TRAEFIK_CONFIG_MOUNT="$(printf '    configs:\n      - source: deplo-panel\n        target: /deplo-dynamic/deplo-panel.yml\n        mode: 256')"
  # Unquoted scalars on purpose: this is byte-for-byte what `withPanelRoute`
  # re-renders, so the first edit from the panel produces no spurious diff in the
  # file an operator may be reading on the host.
  TRAEFIK_PANEL_CONFIG="$(printf 'configs:\n  deplo-panel:\n    content: |\n      http:\n        routers:\n          deplo-panel:\n            rule: Host(`%s`)\n            entryPoints:\n              - websecure\n            service: deplo-panel\n            priority: 2\n            tls:\n              certResolver: letsencrypt\n        services:\n          deplo-panel:\n            loadBalancer:\n              servers:\n                - url: http://deplo:3000\n              passHostHeader: true' "$DEPLO_DOMAIN")"
  TRAEFIK_FILE_PROVIDER="$(printf '      - --providers.file.directory=/deplo-dynamic\n      - --providers.file.watch=true')"
else
  USE_DOMAIN=false
  PUBLIC_URL="http://$SERVER_IP:3000"
  TRAEFIK_CONFIG_MOUNT=""
  TRAEFIK_PANEL_CONFIG=""
  TRAEFIK_FILE_PROVIDER=""
fi

# 3. Traefik (always up; routes deployed apps, and the panel in domain mode)
step "Configuring Traefik reverse proxy + Let's Encrypt..."
# traefik:v3.7 (NOT v3.3): Docker Engine 29 raised the min API to 1.40, which
# Traefik <=3.3 cannot negotiate, breaking the docker provider on every poll.
# container_name is what the agent identifies OUR proxy by - without it Deplo
# refuses to manage this stack and the panel's own settings go read-only.
cat > "$DEPLO_DIR/traefik/docker-compose.yml" <<YAML
services:
  traefik:
    image: traefik:v3.7
    container_name: deplo-traefik
    restart: unless-stopped
    depends_on:
      - deplo-socket-proxy
    command:
      - --providers.docker=true
      - --providers.docker.endpoint=tcp://deplo-socket-proxy:2375
      - --providers.docker.exposedbydefault=false
      - --providers.docker.network=deplo
$TRAEFIK_FILE_PROVIDER
      - --entrypoints.web.address=:80
      - --entrypoints.web.http.redirections.entrypoint.to=websecure
      - --entrypoints.web.http.redirections.entrypoint.scheme=https
      # Pinned BELOW the routes on :80. A Traefik entrypoint redirection is a
      # router of its own at a priority nothing can outrank (measured: a route at
      # MaxInt32 still gets the 301), so without this every plain-HTTP route on
      # this host is answered with a redirect to an https it has no certificate
      # for - the panel when its HTTPS is off, and EVERY app domain on the `none`
      # certificate provider, which is the default a new domain is born with.
      # A host with no route of its own still redirects, which is the job.
      - --entrypoints.web.http.redirections.entrypoint.priority=1
      - --entrypoints.websecure.address=:443
      - --certificatesresolvers.letsencrypt.acme.httpchallenge=true
      - --certificatesresolvers.letsencrypt.acme.httpchallenge.entrypoint=web
      - --certificatesresolvers.letsencrypt.acme.email=\${ACME_EMAIL}
      - --certificatesresolvers.letsencrypt.acme.storage=/acme/acme.json
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - /opt/deplo/acme:/acme
    networks:
      - deplo
      - deplo-socket
$TRAEFIK_CONFIG_MOUNT
  # Traefik reads the container labels it routes on THROUGH this, instead of
  # holding /var/run/docker.sock itself. A \`:ro\` mount would not have helped:
  # read-only is about the socket FILE, while the API behind it stays complete,
  # so any code execution inside the internet-facing proxy is root on the host.
  # This filter is the actual boundary - GET-only (POST=0), and only the four
  # endpoints the docker provider reads.
  deplo-socket-proxy:
    image: tecnativa/docker-socket-proxy:v0.5.0
    restart: unless-stopped
    environment:
      - CONTAINERS=1
      - NETWORKS=1
      - EVENTS=1
      - VERSION=1
      - POST=0
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    networks:
      - deplo-socket
$TRAEFIK_PANEL_CONFIG
networks:
  deplo:
    external: true
  # NOT the shared \`deplo\` network: every deployed app sits on that one, and a
  # socket proxy reachable from them would let any app enumerate every other
  # team's containers - environment variables included. Traefik straddles both;
  # this leg is internal (no route off the host) and holds only these two.
  deplo-socket:
    internal: true
YAML
# Blank lines from an empty block above are harmless YAML, but strip them so the
# file an operator opens on the host reads like one somebody wrote.
sed -i '/^$/d' "$DEPLO_DIR/traefik/docker-compose.yml"
docker compose -f "$DEPLO_DIR/traefik/docker-compose.yml" --env-file "$ENV_FILE" up -d
ok "Traefik running"

# The server agent manages the proxy at $AGENT_DATA/traefik - that is the one
# path TraefikConfig reads and writes. Point it at the stack we just wrote so
# THIS host's proxy is manageable from the panel like every other host's, instead
# of the agent installing a second Traefik that cannot have :80/:443.
#
# A symlink rather than a move: uninstall.sh does `rm -rf $AGENT_DATA`,
# which takes the link and leaves the control plane's Traefik (and its acme.json,
# i.e. every certificate already issued) exactly where it is. Never overwrite a
# real directory there - that would be an agent that installed its own proxy
# first, and adopting it silently is not ours to do.
if [ ! -e /var/lib/deplo-agent/traefik ]; then
  mkdir -p /var/lib/deplo-agent
  chmod 700 /var/lib/deplo-agent
  ln -s "$DEPLO_DIR/traefik" /var/lib/deplo-agent/traefik
fi

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
    # NOT the shared \`deplo\` network - the same rule the socket proxy above
    # follows, for the same reason one layer down. Every deployed app sits on
    # that network and every container there can register a DNS name, so a
    # tenant stack with a service called \`postgres\` would round-robin the
    # control plane's own database lookups onto a container they control - and
    # what arrives on the first packet is the password in the connection string.
    # This leg is internal (no route off the host) and holds only these two.
    networks:
      - deplo-internal
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
      - DEPLO_HOST_BOOTSTRAP_TOKEN=\${DEPLO_HOST_BOOTSTRAP_TOKEN}
      - DEPLO_HOST_NAME=$HOST_NAME
      - DEPLO_DATABASE_URL=postgres://deplo:\${DEPLO_DB_PASSWORD}@postgres:5432/deplo
      - DEPLO_ACME_EMAIL=\${ACME_EMAIL}
    # NO docker.sock. The panel is the one container on this host reachable from
    # the internet, and a socket mount is root on the box for whoever reaches it -
    # so ADR-0006's "the control plane never touches a Docker socket" has to hold
    # here in the compose file, not just in the code. Everything host-coupled goes
    # over mTLS gRPC to the server agent, including on THIS host (agent 0), which
    # runs as its own systemd unit outside this stack.
    volumes:
      - /opt/deplo/data:/data
    networks:
      - deplo
      - deplo-internal
$DEPLO_EXPOSE

volumes:
  deplo-postgres:

networks:
  deplo:
    external: true
  # The panel and its database, and nothing else on it.
  deplo-internal:
    internal: true
EOF

# Pull the control-plane image first so a bad version tag (or, on an update, the
# newest image) fails clearly instead of a cryptic compose error. The image is
# public, so let Docker's own message through rather than guessing the cause.
step "Pulling $DEPLO_IMAGE..."
if ! docker pull "$DEPLO_IMAGE" >/dev/null; then
  err "Could not pull $DEPLO_IMAGE."
  err "Check the internet connection, and that DEPLO_VERSION=$DEPLO_VERSION is a released version."
  exit 1
fi

step "Starting Postgres and the Deplo control plane..."
docker compose -f "$DEPLO_DIR/docker-compose.yml" --env-file "$ENV_FILE" up -d
ok "Deplo control plane running"

# 5. This host is a server too (agent 0) --------------------------------------
#
# Without this, a brand-new install comes up with an EMPTY server list and the
# first deploy is impossible: every deploy goes through a server agent, and the
# only other way to get one is to copy a command out of the dashboard and paste
# it into an SSH session on this very box. Deplo exists to remove that trip, so
# the installer - which is already root here - does it.
#
# The panel cannot do this for itself: it runs in a container with no Docker
# socket and no host access, on purpose. What it CAN do is arm a one-time
# bootstrap on its own server row from $HOST_TOKEN, which is exactly the token
# handed to the agent installer below. From there the agent calls home and gets
# its certificate signed like any other server - no second trust path.
#
# Always over the IP address, never the domain: in domain mode DNS may not point
# here yet and the certificate may not have issued, while :3000 answers from the
# moment the panel is up. The URL is used only to bootstrap; afterwards the panel
# dials the agent, not the other way round.
AGENT_BOOTSTRAP_URL="http://$SERVER_IP:3000"

enroll_this_host() {
  if [ -x /usr/local/bin/deplo-agent ]; then
    ok "Server agent already installed on this host"
    return 0
  fi
  step "Waiting for the control plane to answer..."
  i=0
  while true; do
    if curl -fsS -o /dev/null "$AGENT_BOOTSTRAP_URL/api/health"; then break; fi
    i=$((i + 1))
    if [ "$i" -ge 60 ]; then
      err "The control plane did not answer on $AGENT_BOOTSTRAP_URL after 2 minutes."
      return 1
    fi
    sleep 2
  done
  step "Installing the server agent on this host..."
  # No `sudo`: this script already runs as root (checked at the top).
  curl -fsSL "$AGENT_BOOTSTRAP_URL/install-agent.sh" \
    | bash -s -- "$HOST_TOKEN" "$AGENT_BOOTSTRAP_URL" || return 1
}

# Warn and carry on. A panel that is up with one server left to finish is a far
# better place to land than no panel at all, and everything needed to retry is on
# the box: re-running this script re-arms the token and installs the agent again.
HOST_ENROLLED=true
if ! enroll_this_host; then
  HOST_ENROLLED=false
  err "This host was not added as a server. Deplo itself is installed and running."
  err "Re-run this script to try again, or add the server from Settings > Servers."
fi

if [ "$MODE" = update ]; then
  bold "Deplo updated"
else
  bold "Deplo installed"
fi
echo ""
echo "  Dashboard:  $PUBLIC_URL"
echo "  Data dir:   $DEPLO_DIR"
echo "  Database:   Postgres (private, internal network only)"
if [ "$HOST_ENROLLED" = true ]; then
  echo "  Server:     ${HOST_NAME:-$SERVER_IP} (this machine, added as a server)"
fi
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
