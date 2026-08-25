#!/usr/bin/env bash
#
# Deplo UNINSTALLER - the counterpart to install.sh.
#
# Takes Deplo off this machine: the control plane in /opt/deplo, the server
# agent, Traefik, the `deplo` network, and every container Deplo deployed here.
#
#   curl -fsSL https://<deplo>/uninstall.sh | sudo bash -s -- --yes
#
# Flags:
#   (none)           DRY RUN - print exactly what would be removed, change nothing.
#   --yes            Actually do it.
#   --agent-only     Leave the control plane alone and remove only this host's
#                    agent, its Traefik and the containers Deplo deployed here.
#                    This is what you run on a server you have just removed from
#                    the fleet in the dashboard.
#   --purge-data     ALSO delete app/database volumes, images Deplo built,
#                    /data/stacks and /opt/deplo - which holds .env, and .env
#                    holds DEPLO_SECRET. IRREVERSIBLE.
#   --purge-backups  ALSO delete /data/backups, every backup artifact stored on
#                    this host. IRREVERSIBLE, and those are the last copies.
#   --help
#
# What it NEVER touches: Docker Engine itself; /etc/docker/daemon.json, where the
# installer widened Docker's address pools (the original is next to it as
# daemon.json.deplo-bak); and any container Deplo did not label. Without
# --purge-data it also never deletes a volume, an image, /opt/deplo or /data - a
# decommission stays reversible until you say otherwise.
#
# Safe to run on a host that never had Deplo (every step is skipped when its
# target is absent) and safe to run twice.
set -euo pipefail

DEPLO_DIR="/opt/deplo"
CP_COMPOSE="$DEPLO_DIR/docker-compose.yml"
CP_ENV="$DEPLO_DIR/.env"
CP_TRAEFIK_COMPOSE="$DEPLO_DIR/traefik/docker-compose.yml"

AGENT_BIN="/usr/local/bin/deplo-agent"
AGENT_DATA="/var/lib/deplo-agent"
UNIT="/etc/systemd/system/deplo-agent.service"
TRAEFIK_DIR="$AGENT_DATA/traefik"

# Containers Deplo names explicitly (they carry no deplo.managed label, so the
# label sweep below would miss them): the reverse proxy and the legacy SSH
# gateway pair (dev mode was removed from Deplo; hosts provisioned before the
# removal may still carry the two gateway containers, so the sweep stays).
NAMED_CONTAINERS=(deplo-traefik deplo-ssh-gateway deplo-ssh-gateway-proxy)

# The control plane's own containers, named by compose from the directory it
# lives in: /opt/deplo -> project `deplo`, /opt/deplo/traefik -> project `traefik`.
# Only used as a fallback when the compose files are already gone - `compose
# down` is the right way to stop a stack, this is the way to stop a stack whose
# file somebody deleted first.
CP_CONTAINERS=(deplo-deplo-1 deplo-postgres-1 traefik-deplo-socket-proxy-1)

err()  { printf "\033[31m[!!]\033[0m %s\n" "$1" >&2; }
warn() { printf "\033[33m[!!]\033[0m %s\n" "$1"; }
step() { printf "\033[36m[..]\033[0m %s\n" "$1"; }
skip() { printf "\033[90m[--]\033[0m %s\n" "$1"; }
# Past-tense: only ever printed when something actually happened. In a dry run the
# printed `$ command` lines already say what WOULD happen - claiming "removed"
# there would be the same kind of lie this script exists to correct.
ok()   { [ "$APPLY" = true ] && printf "\033[32m[ok]\033[0m %s\n" "$1"; return 0; }

APPLY=false
PURGE=false
PURGE_BACKUPS=false
# One line, one token, on purpose: the control plane serves this script at the
# legacy /uninstall-agent.sh URL with this flipped to `true`, so a one-liner
# copied into a runbook before uninstall.sh existed keeps meaning exactly what it
# meant then - remove the agent, leave the panel alone.
AGENT_ONLY=false
for arg in "$@"; do
  case "$arg" in
    --yes|-y)        APPLY=true ;;
    --agent-only)    AGENT_ONLY=true ;;
    --purge-data)    PURGE=true ;;
    --purge-backups) PURGE_BACKUPS=true ;;
    --help|-h)
      sed -n '2,31p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      err "Unknown flag '$arg'. Use --yes to execute, --agent-only to keep the control plane, --purge-data / --purge-backups to also delete data, --help."
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
  if [ "$AGENT_ONLY" = true ]; then
    printf "\n\033[1mUninstalling the Deplo agent from this host\033[0m\n\n"
  else
    printf "\n\033[1mUninstalling Deplo from this host\033[0m\n\n"
  fi
else
  printf "\n\033[1mDRY RUN\033[0m - nothing will be changed. These are the commands that --yes would run.\n\n"
fi

# 1. The control plane -------------------------------------------------------
# First, and by `compose down` rather than `docker rm`: the panel and its
# Postgres must be stopped before Traefik and the `deplo` network go away under
# them. Skipped entirely with --agent-only.
if [ "$AGENT_ONLY" = true ]; then
  if [ -f "$CP_COMPOSE" ]; then
    warn "--agent-only: the control plane in $DEPLO_DIR stays. Its Traefik does not -"
    warn "the panel keeps answering on :3000, and re-running install.sh brings :80/:443 back."
  fi
elif [ "$HAVE_DOCKER" = true ] && [ -f "$CP_COMPOSE" ]; then
  # -v ONLY under --purge-data: this is the volume that holds the panel's entire
  # database (deplo_deplo-postgres), so it goes when data goes, and not before.
  DOWN_ARGS=(down --remove-orphans)
  [ "$PURGE" = true ] && DOWN_ARGS=(down -v --remove-orphans)
  step "Stopping the Deplo control plane and its Postgres"
  run docker compose -f "$CP_COMPOSE" --env-file "$CP_ENV" "${DOWN_ARGS[@]}"
  if [ -f "$CP_TRAEFIK_COMPOSE" ]; then
    step "Stopping the control plane's Traefik and socket proxy"
    run docker compose -f "$CP_TRAEFIK_COMPOSE" --env-file "$CP_ENV" down --remove-orphans
  fi
  ok "Control plane stopped"
elif [ "$HAVE_DOCKER" = true ]; then
  # No compose file: either this host never ran a control plane, or somebody
  # deleted /opt/deplo before running this. Sweep the deterministic names so the
  # second case does not leave a panel running with nothing to stop it by.
  LEFTOVER=""
  for c in "${CP_CONTAINERS[@]}"; do
    docker ps -aq --filter "name=^${c}$" | grep -q . && LEFTOVER="$LEFTOVER $c"
  done
  if [ -n "$LEFTOVER" ]; then
    step "Removing control-plane containers left without their compose file"
    # shellcheck disable=SC2086 # word splitting is the point: one name per arg
    run docker rm -f $LEFTOVER
  else
    skip "No Deplo control plane on this host"
  fi
else
  skip "No Deplo control plane on this host"
fi

# 2. The agent service -------------------------------------------------------
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

# 3. Containers Deplo runs on this host -------------------------------------
if [ "$HAVE_DOCKER" = true ]; then
  # Traefik first, via its compose file when we still have it, so the network is
  # left detached and the sweep below can drop it. On the control-plane host
  # $TRAEFIK_DIR is a symlink into /opt/deplo/traefik, which step 1 already took
  # down - `compose down` on a stopped project is a no-op, not an error.
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

  # Every stack Deplo deploys - apps, databases, plus legacy dev containers from
  # before dev mode was removed - carries deplo.managed=true (lib/deploy/build.ts).
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

  for n in deplo deplo_deplo-internal traefik_deplo-socket deplo-ssh-gateway_deplo-ssh-internal; do
    # The last two are compose-owned and normally went with their `down` above;
    # named here for the host whose compose files were deleted first.
    if docker network inspect "$n" >/dev/null 2>&1; then
      step "Removing the '$n' docker network"
      run docker network rm "$n"
    fi
  done
  ok "Deplo containers and networks removed"
else
  skip "Docker is not installed - no containers or networks to remove"
fi

# 4. Agent state ------------------------------------------------------------
# Takes the mTLS materials AND the Traefik acme.json (issued certificates) with
# it. Called out explicitly because Let's Encrypt rate-limits re-issuance. On the
# control-plane host $AGENT_DATA/traefik is a SYMLINK into /opt/deplo, so this
# removes the link and never the certificates behind it.
if [ -d "$AGENT_DATA" ]; then
  step "Removing $AGENT_DATA (mTLS certs + Traefik's acme.json)"
  run rm -rf "$AGENT_DATA"
  ok "Agent state removed"
else
  skip "No agent state at $AGENT_DATA"
fi

# 5. Data - ONLY with --purge-data -------------------------------------------
if [ "$PURGE" = true ]; then
  printf "\n\033[31m[!!]\033[0m \033[1m--purge-data: deleting volumes, images and data. This is irreversible.\033[0m\n"
  if [ "$AGENT_ONLY" != true ]; then
    printf "\033[31m[!!]\033[0m \033[1m%s/.env goes with it, and that file holds DEPLO_SECRET -\033[0m\n" "$DEPLO_DIR"
    printf "\033[31m[!!]\033[0m \033[1mwithout it no backup artifact of this instance can ever be decrypted.\033[0m\n"
  fi
  if [ "$HAVE_DOCKER" = true ]; then
    if [ "$AGENT_ONLY" = true ]; then
      # `deplo_` (underscore) is the control plane's own compose project, and
      # deplo_deplo-postgres is the panel's DATABASE. An agent-only uninstall
      # leaves the panel running, so its volumes are not ours to delete. Apps and
      # databases are named `deplo-<slug>-<volume>`, which the hyphen keeps.
      VOLS="$(docker volume ls -q 2>/dev/null | grep -E '^deplo-' || true)"
    else
      VOLS="$(docker volume ls -q 2>/dev/null | grep -E '^deplo' || true)"
    fi
    if [ -n "$VOLS" ]; then
      step "Removing $(printf '%s\n' "$VOLS" | wc -l | tr -d ' ') deplo volume(s)"
      # shellcheck disable=SC2086
      run docker volume rm $VOLS
    fi
    IMGS="$(docker images -q 'deplo/*' 2>/dev/null || true)"
    [ "$AGENT_ONLY" != true ] && IMGS="$IMGS $(docker images -q 'ghcr.io/deplocloud/deplo' 2>/dev/null || true)"
    IMGS="$(printf '%s' "$IMGS" | tr ' ' '\n' | grep -v '^$' || true)"
    if [ -n "$IMGS" ]; then
      step "Removing $(printf '%s\n' "$IMGS" | wc -l | tr -d ' ') image(s) Deplo built or pulled"
      # shellcheck disable=SC2086
      run docker rmi -f $IMGS
    fi
  fi
  step "Removing /data/stacks and /data/dev"
  run rm -rf /data/stacks /data/dev
  if [ "$AGENT_ONLY" != true ] && [ -d "$DEPLO_DIR" ]; then
    step "Removing $DEPLO_DIR (.env with DEPLO_SECRET, the panel's /data, acme.json)"
    run rm -rf "$DEPLO_DIR"
  fi
  ok "Data purged"
fi

# 6. Backups - ONLY with --purge-backups -------------------------------------
# Its own flag rather than part of --purge-data: everything above can be rebuilt
# from a backup, and these ARE the backups.
if [ "$PURGE_BACKUPS" = true ]; then
  if [ -d /data/backups ]; then
    printf "\n\033[31m[!!]\033[0m \033[1m--purge-backups: deleting /data/backups, the last copy of this host's data.\033[0m\n"
    step "Removing /data/backups"
    run rm -rf /data/backups
    ok "Backups purged"
  else
    skip "No backups at /data/backups"
  fi
fi

# 7. What we deliberately left behind ----------------------------------------
printf "\n"
if [ "$APPLY" = true ]; then
  if [ "$AGENT_ONLY" = true ]; then
    ok "This host is no longer a Deplo server."
  else
    ok "Deplo is off this machine."
  fi
else
  printf "\033[1mDry run finished - nothing was changed.\033[0m\n"
  printf "Re-run with \033[1m--yes\033[0m to execute.\n"
fi
printf "\n\033[1mLeft in place on purpose:\033[0m\n"
printf "  · Docker Engine - Deplo installed it, but other things may use it now.\n"
printf "    Remove it yourself if you want it gone.\n"
printf "  · /etc/docker/daemon.json - Deplo widened Docker's address pools there and\n"
printf "    kept your original as daemon.json.deplo-bak. Restoring it needs a Docker\n"
printf "    restart, which stops every container on this machine, so it is your call.\n"
printf "  · Any container Deplo did not label (yours, or another panel's).\n"
if [ "$PURGE" != true ]; then
  printf "  · Every deplo-* volume, image built by Deplo, /data/stacks"
  [ "$AGENT_ONLY" != true ] && printf ", $DEPLO_DIR"
  printf " -\n"
  printf "    your apps' and databases' DATA"
  [ "$AGENT_ONLY" != true ] && printf " and DEPLO_SECRET"
  printf ". Re-run with --purge-data to\n"
  printf "    delete those too (irreversible).\n"
fi
if [ "$PURGE_BACKUPS" != true ] && [ -d /data/backups ]; then
  printf "  · /data/backups - every backup artifact stored here. Re-run with\n"
  printf "    --purge-backups to delete those too (irreversible).\n"
fi
printf "\n"
