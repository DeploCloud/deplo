#!/usr/bin/env bash
#
# Deplo SERVER-AGENT installer (PLAN Part B). Run on a remote Linux host to turn
# it into a Deplo server: installs Docker (if absent) + the `deplo-agent` binary,
# writes a systemd unit, and starts the agent in BOOTSTRAP mode. The agent then
# generates its own key, sends a CSR to the control plane, gets a signed cert,
# and starts serving — at which point the server flips to "online" in the
# dashboard. The control plane NEVER SSHes into this box; the agent connects out.
#
# You do not run this by hand from memory — the dashboard's "Add remote server"
# gives you the exact command, already filled in:
#
#   curl -fsSL https://<deplo>/install-agent.sh | sudo bash -s -- <TOKEN> <URL> [FINGERPRINT]
#
# Args (positional, passed after `--`):
#   $1  TOKEN        one-time bootstrap token (single-use, ~1h expiry)
#   $2  URL          the control plane's public base URL (http(s)://host[:port])
#   $3  FINGERPRINT  (optional) sha256 of the control plane's TLS cert to pin;
#                    present over HTTPS, absent over plain HTTP (the token then
#                    binds the response via HMAC instead).
#
# The control plane serves this script and the binary over its own domain and
# pins the binary's sha256 below (substituted at serve time) — the script REFUSES
# to run a binary whose checksum does not match (P2).
set -euo pipefail

# --- These two are substituted by the control plane when it serves the script.
# (When read straight from the repo they are left as placeholders and the script
# errors clearly — this file is a template, fetched via /install-agent.sh.)
AGENT_BIN_URL="__AGENT_BIN_URL__"
AGENT_SHA256="__AGENT_SHA256__"

INSTALL_DIR="/usr/local/bin"
AGENT_BIN="$INSTALL_DIR/deplo-agent"
AGENT_DATA="/var/lib/deplo-agent"
UNIT="/etc/systemd/system/deplo-agent.service"
AGENT_PORT="${DEPLO_AGENT_PORT:-9443}"

err()  { printf "\033[31m[!!]\033[0m %s\n" "$1" >&2; }
step() { printf "\033[36m[..]\033[0m %s\n" "$1"; }
ok()   { printf "\033[32m[ok]\033[0m %s\n" "$1"; }

TOKEN="${1:-}"
URL="${2:-}"
FINGERPRINT="${3:-}"

if [ -z "$TOKEN" ] || [ -z "$URL" ]; then
  err "Usage: install-agent.sh -- <token> <control-plane-url> [fingerprint]"
  err "Copy the exact command from the dashboard's Add remote server dialog."
  exit 1
fi
# Detect the UNSUBSTITUTED template (someone ran the repo copy directly). The
# control plane fills the value above via a plain text replace of the sentinel
# token, so this check must NOT contain that exact token — otherwise it would be
# rewritten to the real URL too and the guard would always fire on the rendered
# script. Match the sentinel's shape with a glob (the token split by a `*`) so the
# exact string never appears literally anywhere a replace could touch.
case "$AGENT_BIN_URL" in
  *__AGENT_BIN*URL__*)
    err "This script must be fetched from the control plane (/install-agent.sh),"
    err "which fills in the binary URL + checksum. Don't run the repo copy directly."
    exit 1
    ;;
esac
if [ "$(id -u)" -ne 0 ]; then
  err "Please run as root (or with sudo)."
  exit 1
fi
for bin in curl sha256sum systemctl; do
  command -v "$bin" >/dev/null 2>&1 || { err "$bin is required."; exit 1; }
done

# 1. Docker -----------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  step "Installing Docker..."
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
  ok "Docker installed"
else
  ok "Docker already installed"
fi

# 2. Agent binary (checksum-verified before it ever runs, P2) ----------------
step "Downloading the Deplo agent..."
TMP="$(mktemp)"
curl -fsSL "$AGENT_BIN_URL" -o "$TMP"
GOT="$(sha256sum "$TMP" | awk '{print $1}')"
if [ "$GOT" != "$AGENT_SHA256" ]; then
  rm -f "$TMP"
  err "Agent binary checksum mismatch (expected $AGENT_SHA256, got $GOT)."
  err "Refusing to run an unverified binary."
  exit 1
fi
install -m 0755 "$TMP" "$AGENT_BIN"
rm -f "$TMP"
ok "Agent installed at $AGENT_BIN (checksum verified)"

# 3. Data dir --------------------------------------------------------------
mkdir -p "$AGENT_DATA"
chmod 700 "$AGENT_DATA"

# 3b. Traefik reverse proxy (idempotent) ------------------------------------
# Deplo's deploys emit `traefik.*` labels and join the shared `deplo` network, but
# something must READ those labels and route traffic — that is Traefik. The master
# host runs it; a remote needs its own. Install it here, but never fight for the
# box: skip if a Traefik is already running (idempotent re-runs, or the operator's
# own proxy), and only claim :80/:443 if they are free — otherwise warn and let
# the operator wire their existing proxy to the `deplo` network.
TRAEFIK_DIR="$AGENT_DATA/traefik"
if docker ps --filter status=running --format '{{.Image}} {{.Names}}' 2>/dev/null \
     | grep -qi traefik; then
  ok "Traefik already running — leaving it untouched"
else
  # Is anything already bound to 80 or 443? (ss if present, else netstat, else
  # a best-effort docker port check.) If so, don't try to bind them.
  PORTS_FREE=true
  if command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | awk '{print $4}' | grep -Eq '(^|[.:])(80|443)$' && PORTS_FREE=false
  elif command -v netstat >/dev/null 2>&1; then
    netstat -ltn 2>/dev/null | awk '{print $4}' | grep -Eq '(^|[.:])(80|443)$' && PORTS_FREE=false
  fi
  if [ "$PORTS_FREE" != true ]; then
    err "Ports 80/443 are already in use on this host — NOT installing Traefik."
    err "Routing for apps deployed here will not work until a reverse proxy on the"
    err "shared 'deplo' docker network handles their traefik.* labels. Point your"
    err "existing proxy at the 'deplo' network, or free 80/443 and re-run."
  else
    step "Installing Traefik reverse proxy..."
    docker network create deplo >/dev/null 2>&1 || true
    mkdir -p "$TRAEFIK_DIR/acme"
    touch "$TRAEFIK_DIR/acme/acme.json"
    chmod 600 "$TRAEFIK_DIR/acme/acme.json"
    # traefik:v3.7 (NOT v3.3): Docker Engine 29 raised the min API to 1.40, which
    # Traefik <=3.3 can't negotiate, breaking the docker provider on every poll.
    # ACME is HTTP-01, same as the master — it issues certs for apps deployed here
    # whose domains resolve (DNS) to this host. The acme dir persists certs.
    cat > "$TRAEFIK_DIR/docker-compose.yml" <<YAML
services:
  traefik:
    image: traefik:v3.7
    container_name: deplo-traefik
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
      - --certificatesresolvers.letsencrypt.acme.email=${ACME_EMAIL:-admin@deluxhost.net}
      - --certificatesresolvers.letsencrypt.acme.storage=/acme/acme.json
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - $TRAEFIK_DIR/acme:/acme
    networks:
      - deplo
networks:
  deplo:
    external: true
YAML
    if docker compose -f "$TRAEFIK_DIR/docker-compose.yml" up -d 2>/dev/null \
       || docker-compose -f "$TRAEFIK_DIR/docker-compose.yml" up -d 2>/dev/null; then
      ok "Traefik running (deplo-traefik)"
    else
      err "Traefik failed to start — apps deployed here won't be routed until it is."
      err "Inspect: docker compose -f $TRAEFIK_DIR/docker-compose.yml logs"
    fi
  fi
fi

# 4. systemd unit -----------------------------------------------------------

# The agent runs in bootstrap mode: it calls home with the token, gets its cert
# signed, persists the materials under $AGENT_DATA, and then serves gRPC. On a
# restart it finds its materials and skips bootstrap. The token + fingerprint are
# only needed for the FIRST run, so they are passed as flags here and the agent
# clears them from its record once provisioned.
step "Writing the systemd unit..."
cat > "$UNIT" <<EOF
[Unit]
Description=Deplo server agent
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
ExecStart=$AGENT_BIN \\
  --addr 0.0.0.0:$AGENT_PORT \\
  --data-dir / \\
  --agent-dir $AGENT_DATA \\
  --bootstrap-url $URL \\
  --bootstrap-token $TOKEN \\
  --bootstrap-fingerprint "$FINGERPRINT"
Restart=on-failure
RestartSec=5
# The agent needs the Docker socket to build + run stacks.
SupplementaryGroups=docker

[Install]
WantedBy=multi-user.target
EOF
chmod 600 "$UNIT"

step "Starting the agent..."
systemctl daemon-reload
systemctl enable --now deplo-agent

ok "Deplo agent running on port $AGENT_PORT"
echo ""
echo "  The agent is calling home to $URL to finish provisioning."
echo "  Watch the dashboard — this server will switch to 'online' shortly."
echo "  Logs: journalctl -u deplo-agent -f"
echo ""
