#!/usr/bin/env bash
#
# Deplo SERVER-AGENT uninstaller — the counterpart to install-agent.sh.
#
# Removing a server in the dashboard is TRUST REVOCATION, not an uninstall: the
# control plane forgets the server and drops its pinned certificate, but it has
# no RPC that can delete the agent binary, its systemd unit, Traefik, or the
# `deplo` docker network — and it stops being able to talk to the box the moment
# trust is revoked. So the host cleanup is a host-side act: this script.
#
#   curl -fsSL https://<deplo>/uninstall-agent.sh | sudo bash -s -- --yes
#
# Flags:
#   (none)        DRY RUN — print exactly what would be removed, change nothing.
#   --yes         Actually do it.
#   --purge-data  ALSO delete app/database volumes, built images and /data.
#                 IRREVERSIBLE — this is the flag that destroys data.
#   --help
#
# What it NEVER touches: Docker Engine itself, and any container Deplo did not
# label. Without --purge-data it also never deletes a volume, an image, or /data
# — a decommission stays reversible until you say otherwise.
#
# Safe to run on a host that was never a Deplo server (every step is skipped when
# its target is absent) and safe to run twice.
set -euo pipefail

AGENT_BIN="/usr/local/bin/deplo-agent"
AGENT_DATA="/var/lib/deplo-agent"
UNIT="/etc/systemd/system/deplo-agent.service"
TRAEFIK_DIR="$AGENT_DATA/traefik"

# Containers Deplo names explicitly (they carry no deplo.managed label, so the
# label sweep below would miss them): the reverse proxy and the legacy SSH
# gateway pair (dev mode was removed from Deplo; hosts provisioned before the
# removal may still carry the two gateway containers, so the sweep stays).
NAMED_CONTAINERS=(deplo-traefik deplo-ssh-gateway deplo-ssh-gateway-proxy)

err()  { printf "\033[31m[!!]\033[0m %s\n" "$1" >&2; }
step() { printf "\033[36m[..]\033[0m %s\n" "$1"; }
skip() { printf "\033[90m[--]\033[0m %s\n" "$1"; }
# Past-tense: only ever printed when something actually happened. In a dry run the
# printed `$ command` lines already say what WOULD happen — claiming "removed"
# there would be the same kind of lie this script exists to correct.
ok()   { [ "$APPLY" = true ] && printf "\033[32m[ok]\033[0m %s\n" "$1"; return 0; }

APPLY=false
PURGE=false
for arg in "$@"; do
  case "$arg" in
    --yes|-y)     APPLY=true ;;
    --purge-data) PURGE=true ;;
    --help|-h)
      sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      err "Unknown flag '$arg'. Use --yes to execute, --purge-data to also delete data, --help."
      exit 1
      ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  err "Please run as root (or with sudo)."
  exit 1
fi

# In dry-run every mutation is printed instead of executed, so the operator sees
# the exact commands before authorizing them. Everything below goes through run().
run() {
  if [ "$APPLY" = true ]; then
    "$@" >/dev/null 2>&1 || true
  else
    printf "     \033[90m$ %s\033[0m\n" "$*"
  fi
}

HAVE_DOCKER=false
command -v docker >/dev/null 2>&1 && HAVE_DOCKER=true

if [ "$APPLY" = true ]; then
  printf "\n\033[1mUninstalling the Deplo agent from this host\033[0m\n\n"
else
  printf "\n\033[1mDRY RUN\033[0m — nothing will be changed. These are the commands that --yes would run.\n\n"
fi

# 1. The agent service ------------------------------------------------------
# Stop it FIRST: while it lives, systemd restarts it (Restart=on-failure) and it
# keeps holding the docker socket.
if [ -f "$UNIT" ] || systemctl list-unit-files deplo-agent.service >/dev/null 2>&1; then
  step "Stopping and disabling the deplo-agent service"
  run systemctl disable --now deplo-agent
  run rm -f "$UNIT"
  run systemctl daemon-reload
  ok "Agent service removed"
else
  skip "No deplo-agent service on this host"
fi

if [ -f "$AGENT_BIN" ]; then
  step "Removing the agent binary"
  run rm -f "$AGENT_BIN"
  ok "$AGENT_BIN removed"
else
  skip "No agent binary at $AGENT_BIN"
fi

# 2. Containers Deplo runs on this host -------------------------------------
if [ "$HAVE_DOCKER" = true ]; then
  # Traefik first, via its compose file when we still have it, so the network is
  # left detached and step 3 can drop it.
  if [ -f "$TRAEFIK_DIR/docker-compose.yml" ]; then
    step "Stopping Traefik (deplo-traefik)"
    run docker compose -f "$TRAEFIK_DIR/docker-compose.yml" down
  fi
  step "Removing Deplo's named containers (proxy + SSH gateway)"
  for c in "${NAMED_CONTAINERS[@]}"; do
    if docker ps -aq --filter "name=^${c}$" | grep -q .; then
      run docker rm -f "$c"
    fi
  done

  # Every stack Deplo deploys — apps, databases, plus legacy dev containers from
  # before dev mode was removed — carries deplo.managed=true (lib/deploy/build.ts).
  # One label sweep gets all of them, and cannot touch a container Deplo did not create.
  MANAGED="$(docker ps -aq --filter label=deplo.managed=true 2>/dev/null || true)"
  if [ -n "$MANAGED" ]; then
    COUNT="$(printf '%s\n' "$MANAGED" | wc -l | tr -d ' ')"
    step "Removing $COUNT container(s) labelled deplo.managed=true"
    # shellcheck disable=SC2086 # word splitting is the point: one id per arg
    run docker rm -f $MANAGED
  else
    skip "No deplo.managed containers running"
  fi

  if docker network inspect deplo >/dev/null 2>&1; then
    step "Removing the 'deplo' docker network"
    run docker network rm deplo
  fi
  if docker network inspect deplo-ssh-gateway_deplo-ssh-internal >/dev/null 2>&1; then
    run docker network rm deplo-ssh-gateway_deplo-ssh-internal
  fi
  ok "Deplo containers and networks removed"
else
  skip "Docker is not installed — no containers or networks to remove"
fi

# 3. Agent state ------------------------------------------------------------
# Takes the mTLS materials AND the Traefik acme.json (issued certificates) with
# it. Called out explicitly because Let's Encrypt rate-limits re-issuance.
if [ -d "$AGENT_DATA" ]; then
  step "Removing $AGENT_DATA (mTLS certs + Traefik's acme.json)"
  run rm -rf "$AGENT_DATA"
  ok "Agent state removed"
else
  skip "No agent state at $AGENT_DATA"
fi

# 4. Data — ONLY with --purge-data -------------------------------------------
if [ "$PURGE" = true ]; then
  printf "\n\033[31m[!!]\033[0m \033[1m--purge-data: deleting volumes, images and /data. This is irreversible.\033[0m\n"
  if [ "$HAVE_DOCKER" = true ]; then
    VOLS="$(docker volume ls -q 2>/dev/null | grep -E '^deplo' || true)"
    if [ -n "$VOLS" ]; then
      step "Removing $(printf '%s\n' "$VOLS" | wc -l | tr -d ' ') deplo volume(s)"
      # shellcheck disable=SC2086
      run docker volume rm $VOLS
    fi
    IMGS="$(docker images -q 'deplo/*' 2>/dev/null || true)"
    if [ -n "$IMGS" ]; then
      step "Removing $(printf '%s\n' "$IMGS" | wc -l | tr -d ' ') image(s) built by Deplo"
      # shellcheck disable=SC2086
      run docker rmi -f $IMGS
    fi
  fi
  step "Removing /data/stacks and /data/dev"
  run rm -rf /data/stacks /data/dev
  ok "Data purged"
fi

# 5. What we deliberately left behind ----------------------------------------
printf "\n"
if [ "$APPLY" = true ]; then
  ok "This host is no longer a Deplo server."
else
  printf "\033[1mDry run finished — nothing was changed.\033[0m\n"
  printf "Re-run with \033[1m--yes\033[0m to execute.\n"
fi
printf "\n\033[1mLeft in place on purpose:\033[0m\n"
printf "  · Docker Engine — Deplo installed it, but other things may use it now.\n"
printf "    Remove it yourself if you want it gone.\n"
printf "  · Any container Deplo did not label (yours, or another panel's).\n"
if [ "$PURGE" != true ]; then
  printf "  · Every deplo-* volume, image built by Deplo, /data/stacks and /data/dev —\n"
  printf "    your apps' and databases' DATA. Re-run with --purge-data to delete those\n"
  printf "    too (irreversible).\n"
fi
printf "\n"
