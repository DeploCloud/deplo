#!/usr/bin/env bash
#
# Deplo SERVER-AGENT installer (PLAN Part B). Run on a remote Linux host to turn
# it into a Deplo server: installs Docker (if absent) + the `deplo-agent` binary,
# writes a systemd unit, and starts the agent in BOOTSTRAP mode. The agent then
# generates its own key, sends a CSR to the control plane, gets a signed cert,
# and starts serving - at which point the server flips to "online" in the
# dashboard. The control plane NEVER SSHes into this box; the agent connects out.
#
# You do not run this by hand from memory - the dashboard's "Add remote server"
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
# The agent binary ships as a GitHub Release asset (DeploCloud/deplo-agent).
# The control plane serves this script over its own domain and substitutes the
# release's per-arch download URL + sha256 below (read from the release's
# checksums.txt at serve time) - the script REFUSES to run a binary whose
# checksum does not match (P2), even though the bytes come from github.com.
set -euo pipefail

# --- Substituted by the control plane when it serves the script. One URL+sha
# pair per Linux arch; the script selects by `uname -m` below. An arch the
# release didn't publish is left empty and the script errors on that host.
# (When read straight from the repo these stay placeholders and the guard below
# refuses to run - this file is a template, fetched via /install-agent.sh.)
AGENT_VERSION="__AGENT_VERSION__"
AGENT_URL_AMD64="__AGENT_URL_AMD64__"
AGENT_SHA256_AMD64="__AGENT_SHA256_AMD64__"
AGENT_URL_ARM64="__AGENT_URL_ARM64__"
AGENT_SHA256_ARM64="__AGENT_SHA256_ARM64__"

INSTALL_DIR="/usr/local/bin"
AGENT_BIN="$INSTALL_DIR/deplo-agent"
AGENT_DATA="/var/lib/deplo-agent"
UNIT="/etc/systemd/system/deplo-agent.service"
AGENT_PORT="${DEPLO_AGENT_PORT:-9443}"

# A STORAGE-ONLY host: the agent is installed to hold backups and nothing else.
# No Docker, no address pools, no Traefik, and no `docker` group on the unit -
# systemd refuses to start a service whose SupplementaryGroups does not exist
# (status=216/GROUP), which under `set -e` aborts this script at the last line.
# Set from the dashboard's Add server dialog, which prefixes the copy-paste
# command with DEPLO_STORAGE_ONLY=1 when the box is ticked.
STORAGE_ONLY="${DEPLO_STORAGE_ONLY:-0}"
# A BUILD SERVER: Docker and the address pools exactly as usual (it runs the whole
# build pipeline), but no Traefik - nothing is routed to a host that runs nothing.
# Set from the dashboard's Add server dialog, which prefixes the copy-paste command
# with DEPLO_BUILD_ONLY=1 when "Only build" is chosen.
BUILD_ONLY="${DEPLO_BUILD_ONLY:-0}"
# A MIGRATION SOURCE: another platform's host, which Deplo installs an agent on
# for one purpose - reading the volumes it is importing. It is the narrowest
# install there is, and deliberately: Docker is already there and is never
# installed, the address pools are NOT rewritten (that edits /etc/docker/
# daemon.json and can restart the daemon under a live workload), no Traefik, and
# not even the `deplo` network. What is left on the box is the unit, the
# binary and the agent state dir - exactly what the agent's SelfUninstall removes
# when the migration ends.
# Set by the import wizard, which prefixes the command with DEPLO_IMPORT_ONLY=1.
IMPORT_ONLY="${DEPLO_IMPORT_ONLY:-0}"

err()  { printf "\033[31m[!!]\033[0m %s\n" "$1" >&2; }
warn() { printf "\033[33m[!]\033[0m  %s\n" "$1"; }
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
# control plane fills the values above via a plain text replace of the sentinel
# tokens, so this check must NOT contain an exact token, otherwise it would be
# rewritten to the real value too and the guard would always fire on the rendered
# script. Match the sentinel's shape with a glob (the token split by a `*`) so the
# exact string never appears literally anywhere a replace could touch.
case "$AGENT_URL_AMD64" in
  *__AGENT_URL*AMD64__*)
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
if [ "$STORAGE_ONLY" = "1" ]; then
  ok "Storage-only server: skipping Docker"
elif [ "$IMPORT_ONLY" = "1" ]; then
  # Docker has to be here already - this is the other platform's host, and its
  # volumes are what we came to read. Installing it would be changing a machine we
  # are only borrowing, so a missing Docker is a hard stop instead.
  if ! command -v docker >/dev/null 2>&1; then
    err "Docker is not installed on this host, so there are no volumes to import."
    exit 1
  fi
  ok "Migration source: using the Docker already on this host"
elif ! command -v docker >/dev/null 2>&1; then
  step "Installing Docker..."
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
  ok "Docker installed"
else
  ok "Docker already installed"
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

# A migration source only reads volumes, and a storage-only host only holds
# backups: neither ever builds anything, so neither is worth changing for git.
if [ "$STORAGE_ONLY" != "1" ] && [ "$IMPORT_ONLY" != "1" ]; then
  ensure_git
fi

# 1b. Docker address pools ---------------------------------------------------
# Docker's default pools allow ~31 networks and Deplo burns one PER APP, so an
# untouched host dies on its 32nd deploy. Must run before any network exists:
# only a full daemon restart loads new pools. KEEP IN SYNC with install.sh.
#   1. NEVER hardcode 10.0.0.0/8 - it swallows the host's own LAN/VPN and dockerd
#      then refuses to start. Pick a /13 overlapping NO route already on the box.
#   2. NEVER clobber the operator's daemon.json: an existing pool setting wins.

# Is the /13 at 10.<$1>.0.0 (second octets $1..$1+7) clear of every 10.x route on
# this host? Pure awk - no python, jq or ipcalc required on the target.
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
    ok "Docker address pools already configured, leaving them untouched"
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
    err "Every candidate address pool overlaps a route on this host, NOT touching Docker."
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
      err "Could not parse $CFG as JSON, leaving it untouched."
      err "Add manually: \"default-address-pools\": [{\"base\": \"$BASE\", \"size\": $SIZE}]"
      rm -f "$TMP"; return 0
    }
  elif command -v jq >/dev/null 2>&1; then
    jq --arg b "$BASE" --argjson s "$SIZE" \
      '.["default-address-pools"] = [{base: $b, size: $s}]' "$CFG" > "$TMP" 2>/dev/null || {
      err "Could not parse $CFG as JSON, leaving it untouched."
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
    err "The generated Docker config failed validation, leaving $CFG untouched."
    rm -f "$TMP"; return 0
  fi

  RUNNING="$(docker ps -q 2>/dev/null | wc -l | tr -d ' ' || true)"
  [ -f "$CFG" ] && cp "$CFG" "$CFG.deplo-bak"
  mkdir -p /etc/docker
  install -m 0644 "$TMP" "$CFG"
  rm -f "$TMP"

  # An installer must NEVER bounce someone's running apps. Pools apply at the next
  # daemon restart; until the operator picks a window, this host keeps its ceiling.
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
    err "Docker did not come back after the address-pool change - rolling back."
    if [ -f "$CFG.deplo-bak" ]; then mv "$CFG.deplo-bak" "$CFG"; else rm -f "$CFG"; fi
    systemctl restart docker >/dev/null 2>&1 || true
    if docker info >/dev/null 2>&1; then
      err "Rolled back - Docker is up again, with the default ~31-network ceiling."
    else
      err "Docker is STILL down. Inspect: journalctl -u docker -n 50"
    fi
  fi
}

if [ "$STORAGE_ONLY" = "1" ]; then
  ok "Storage-only server: skipping Docker address pools"
elif [ "$IMPORT_ONLY" = "1" ]; then
  # The one step that would MODIFY the host: it writes /etc/docker/daemon.json and
  # restarts the daemon when nothing is running. Deplo deploys nothing here, so
  # the ceiling this raises is irrelevant - and the change is one the uninstall
  # could never take back.
  ok "Migration source: leaving this host's Docker configuration alone"
else
  configure_docker_address_pools
fi

# 2. Agent binary (checksum-verified before it ever runs, P2) ----------------
# Pick the release asset for this host's architecture. The release publishes
# linux/amd64 and linux/arm64; anything else has no binary and we stop early.
case "$(uname -m)" in
  x86_64|amd64)        AGENT_BIN_URL="$AGENT_URL_AMD64"; AGENT_SHA256="$AGENT_SHA256_AMD64" ;;
  aarch64|arm64)       AGENT_BIN_URL="$AGENT_URL_ARM64"; AGENT_SHA256="$AGENT_SHA256_ARM64" ;;
  *)
    err "Unsupported architecture '$(uname -m)' - the Deplo agent ships linux/amd64 and linux/arm64 only."
    exit 1
    ;;
esac
if [ -z "$AGENT_BIN_URL" ] || [ -z "$AGENT_SHA256" ]; then
  err "The latest agent release has no binary for this architecture ($(uname -m))."
  err "Pick a host with linux/amd64 or linux/arm64, or wait for a release that includes it."
  exit 1
fi

step "Downloading the Deplo agent (v$AGENT_VERSION, $(uname -m))..."
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
ok "Agent v$AGENT_VERSION installed at $AGENT_BIN (checksum verified)"

# 3. Data dir --------------------------------------------------------------
mkdir -p "$AGENT_DATA"
chmod 700 "$AGENT_DATA"

# Re-provisioning: running this installer means a FRESH bootstrap is intended (you
# pasted a one-time token from the dashboard). But the agent skips bootstrap when
# it finds existing mTLS materials on disk, so a reinstall over a previous one
# (e.g. after removing + re-adding the server) would serve the STALE cert and
# never call home, and the control plane, which pinned a new fingerprint at
# re-add - would reject every dial (no metrics, never "online"). Clear the old
# materials here so the agent genuinely re-bootstraps against the current pin.
# (A plain `systemctl restart deplo-agent` carries no token through this script,
# so it still reuses materials and serves straight away, as intended.)
if [ -e "$AGENT_DATA/agent.crt" ] || [ -e "$AGENT_DATA/agent.key" ] || [ -e "$AGENT_DATA/ca.crt" ]; then
  step "Existing agent materials found - clearing them for a fresh bootstrap..."
  systemctl stop deplo-agent 2>/dev/null || true
  rm -f "$AGENT_DATA/agent.crt" "$AGENT_DATA/agent.key" "$AGENT_DATA/ca.crt"
  ok "Old materials cleared (the agent will re-provision with the new token)"
fi

# 3a-bis. The platform's `deplo` network -------------------------------------
# NOT where apps go - since ADR-0028 each Environment owns its own network and the
# agent creates that one itself, on both Deploy and Reroute. This is the network
# TRAEFIK sits on, declared `external: true` in the stack written below, so it has
# to exist before the proxy comes up. It used to be created only inside the Traefik
# branch, and a host that already runs a reverse proxy (which is every host anyone
# MIGRATES from) skips that branch and never got one.
if [ "$IMPORT_ONLY" = "1" ]; then
  ok "Migration source: skipping the 'deplo' network (no proxy is installed here)"
else
  docker network create deplo >/dev/null 2>&1 || true
fi

# 3b. Traefik reverse proxy (idempotent) ------------------------------------
# Deplo's deploys emit `traefik.*` labels and join their Environment's network, but
# something must READ those labels and route traffic - that is Traefik, which the
# agent connects to each of those networks as it creates them. The master
# host runs it; a remote needs its own. Install it here, but never fight for the
# box: skip if a Traefik is already running (idempotent re-runs, or the operator's
# own proxy), and only claim :80/:443 if they are free, otherwise warn and let
# the operator wire their existing proxy to the `deplo` network.
TRAEFIK_DIR="$AGENT_DATA/traefik"
if [ "$STORAGE_ONLY" = "1" ]; then
  ok "Storage-only server: skipping Traefik (nothing is routed here)"
elif [ "$BUILD_ONLY" = "1" ]; then
  ok "Build-only server: skipping Traefik (it builds images, it routes nothing)"
elif [ "$IMPORT_ONLY" = "1" ]; then
  ok "Migration source: skipping Traefik (this host has its own, and it is not ours)"
elif docker ps --filter status=running --format '{{.Image}} {{.Names}}' 2>/dev/null \
     | grep -qi traefik; then
  ok "Traefik already running, leaving it untouched"
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
    err "Ports 80/443 are already in use on this host, NOT installing Traefik."
    err "Routing for apps deployed here will not work until a reverse proxy on the"
    err "shared 'deplo' docker network handles their traefik.* labels. Point your"
    err "existing proxy at the 'deplo' network, or free 80/443 and re-run."
  else
    step "Installing Traefik reverse proxy..."
    mkdir -p "$TRAEFIK_DIR/acme"
    touch "$TRAEFIK_DIR/acme/acme.json"
    chmod 600 "$TRAEFIK_DIR/acme/acme.json"
    # traefik:v3.7 (NOT v3.3): Docker Engine 29 raised the min API to 1.40, which
    # Traefik <=3.3 can't negotiate, breaking the docker provider on every poll.
    # ACME is HTTP-01, same as the master - it issues certs for apps deployed here
    # whose domains resolve (DNS) to this host. The acme dir persists certs.
    cat > "$TRAEFIK_DIR/docker-compose.yml" <<YAML
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
      - --entrypoints.web.address=:80
      - --entrypoints.web.http.redirections.entrypoint.to=websecure
      - --entrypoints.web.http.redirections.entrypoint.scheme=https
      # Pinned BELOW the routes on :80 - see the identical block in install.sh.
      # An entrypoint redirection outranks every router on its entrypoint, so
      # without this every domain on the \`none\` certificate provider (the default
      # for a new domain, served plain-HTTP on \`web\`) is redirected to an https
      # it has no certificate for. A host with no route of its own still redirects.
      - --entrypoints.web.http.redirections.entrypoint.priority=1
      - --entrypoints.websecure.address=:443
      - --certificatesresolvers.letsencrypt.acme.httpchallenge=true
      - --certificatesresolvers.letsencrypt.acme.httpchallenge.entrypoint=web
      - --certificatesresolvers.letsencrypt.acme.email=${ACME_EMAIL:-admin@acme.com}
      - --certificatesresolvers.letsencrypt.acme.storage=/acme/acme.json
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - $TRAEFIK_DIR/acme:/acme
    networks:
      - deplo
      - deplo-socket
  # Same shape as install.sh - Traefik reads container labels THROUGH this rather
  # than holding /var/run/docker.sock. A \`:ro\` mount does not help: read-only is
  # about the socket FILE, the API behind it stays complete, so code execution in
  # the internet-facing proxy would be root on the host. GET-only (POST=0), and
  # only the endpoints the docker provider reads.
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
networks:
  deplo:
    external: true
  # Its own internal leg. Apps live on their Environment's network, but Traefik is
  # on ALL of them and resolves this proxy BY NAME, so an app that could answer to
  # that name would write the host's routing table - and one that could REACH the
  # proxy could enumerate every other team's containers, environment included.
  # Internal: no route off the host, and only Traefik on the other end.
  deplo-socket:
    internal: true
YAML
    if docker compose -f "$TRAEFIK_DIR/docker-compose.yml" up -d 2>/dev/null \
       || docker-compose -f "$TRAEFIK_DIR/docker-compose.yml" up -d 2>/dev/null; then
      ok "Traefik running (deplo-traefik)"
    else
      err "Traefik failed to start - apps deployed here won't be routed until it is."
      err "Inspect: docker compose -f $TRAEFIK_DIR/docker-compose.yml logs"
    fi
  fi
fi

# 4. systemd unit -----------------------------------------------------------

# The agent runs in bootstrap mode: it calls home with the token, gets its cert
# signed, persists the materials under $AGENT_DATA, and then serves gRPC. On a
# restart it finds its materials and skips bootstrap. The token + fingerprint are
# only needed for the FIRST run, so they are handed over here and the agent
# clears them from its record once provisioned.
#
# The token travels in an EnvironmentFile, never on ExecStart. A process's argv
# is world-readable on Linux (`/proc/<pid>/cmdline`, i.e. plain `ps aux`), so a
# `--bootstrap-token` flag would leave the credential legible to every local
# user for as long as the agent runs, and self-update `syscall.Exec`s with the
# SAME argv, so it would outlive every upgrade. `Environment=` in the unit is no
# better: `systemctl show` prints it to unprivileged callers. A 0600 file read by
# systemd leaks through neither, and `/proc/<pid>/environ` is owner-only.
step "Writing the systemd unit..."
# mkdir here and not only in the Traefik block above: that one is skipped on a
# storage-only host, and the agent itself does not create --agent-dir until it
# runs. Restrict the file BEFORE the token is written into it, so there is no
# window where it exists world-readable.
BOOTSTRAP_ENV="$AGENT_DATA/bootstrap.env"
mkdir -p "$AGENT_DATA"
chmod 700 "$AGENT_DATA"
: > "$BOOTSTRAP_ENV"
chmod 600 "$BOOTSTRAP_ENV"
cat > "$BOOTSTRAP_ENV" <<EOF
DEPLO_BOOTSTRAP_URL=$URL
DEPLO_BOOTSTRAP_TOKEN=$TOKEN
DEPLO_BOOTSTRAP_FINGERPRINT=$FINGERPRINT
EOF
# On a STORAGE-ONLY host neither Docker line may appear. `SupplementaryGroups`
# names a group that does not exist there, and systemd refuses to spawn the
# process at all (status=216/GROUP) rather than warning, which, under `set -e`,
# aborts this script on its very last command and leaves the host with an agent
# that never runs.
if [ "$STORAGE_ONLY" = "1" ]; then
  UNIT_AFTER="network-online.target"
  DOCKER_UNIT_LINES=""
else
  UNIT_AFTER="network-online.target docker.service"
  DOCKER_UNIT_LINES="# The agent needs the Docker socket to build + run stacks.
SupplementaryGroups=docker"
fi
cat > "$UNIT" <<EOF
[Unit]
Description=Deplo server agent
After=$UNIT_AFTER
Wants=network-online.target

[Service]
Type=simple
# The \`-\` prefix: once host cleanup has cleared the data dir, a restart of a
# not-yet-removed unit must still start rather than fail on the missing file
# (a provisioned agent skips bootstrap and needs none of these anyway).
EnvironmentFile=-$BOOTSTRAP_ENV
ExecStart=$AGENT_BIN \\
  --addr 0.0.0.0:$AGENT_PORT \\
  --data-dir / \\
  --agent-dir $AGENT_DATA
Restart=on-failure
RestartSec=5
$DOCKER_UNIT_LINES

[Install]
WantedBy=multi-user.target
EOF
chmod 600 "$UNIT"

# The backup store the agent owns. Created here rather than lazily so a
# storage-only box shows the right permissions from the first minute, and so a
# full disk is visible before the first backup rather than during it.
if [ "$IMPORT_ONLY" = "1" ]; then
  ok "Migration source: skipping the backup store (nothing is stored here)"
else
  mkdir -p /data/backups
  chmod 700 /data/backups
fi

step "Starting the agent..."
systemctl daemon-reload
systemctl enable --now deplo-agent

# The panel DIALS the agent on $AGENT_PORT, while the call-home that provisions it
# is outbound and succeeds either way - so a blocked port reads as a server that
# provisions and then never comes online. Report it; never edit someone's firewall.
firewall_fix_command() {
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -qi '^Status: active'; then
    ufw status 2>/dev/null | grep -qE "(^|[^0-9])$AGENT_PORT/tcp" \
      || printf 'ufw allow %s/tcp' "$AGENT_PORT"
  elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
    firewall-cmd --list-ports 2>/dev/null | grep -qE "(^| )$AGENT_PORT/tcp" \
      || printf 'firewall-cmd --permanent --add-port=%s/tcp && firewall-cmd --reload' "$AGENT_PORT"
  fi
}
FIREWALL_FIX="$(firewall_fix_command || true)"

ok "Deplo agent running on port $AGENT_PORT"
echo ""
if [ -n "$FIREWALL_FIX" ]; then
  warn "This host's firewall is blocking TCP $AGENT_PORT - Deplo cannot reach the agent."
  echo ""
  echo "  Provisioning still finishes (the agent calls out to $URL), but the server"
  echo "  stays offline until the port is open. Run:"
  echo ""
  echo "      $FIREWALL_FIX"
  echo ""
else
  echo "  The agent is calling home to $URL to finish provisioning."
  echo "  Watch the dashboard - this server will switch to 'online' shortly."
fi
echo "  Logs: journalctl -u deplo-agent -f"
echo ""
