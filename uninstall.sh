#!/usr/bin/env bash
#
# Deplo UNINSTALLER - the counterpart to install.sh.
#
# Takes Deplo off this machine: the control plane in /opt/deplo, the server
# agent, Traefik, the `deplo` network, and every container Deplo deployed here.
#
#   curl -fsSL https://<deplo>/uninstall.sh | sudo bash -s -- --yes
#
# It opens with an inventory of what it found, then either prints the exact
# commands it would run (the default) or runs them (--yes).
#
# What it NEVER touches: Docker Engine itself; /etc/docker/daemon.json, where the
# installer widened Docker's address pools (the original is next to it as
# daemon.json.deplo-bak); and any container Deplo did not label. Without
# --purge-data it also never deletes a volume, an image, /opt/deplo or the data
# directory - a decommission stays reversible until you say otherwise.
#
# Safe to run on a host that never had Deplo (every step is skipped when its
# target is absent) and safe to run twice.
set -Eeuo pipefail

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

# This install may have been a TAKEOVER of another panel, which is still on the
# machine and, past the cutover, stopped by us. See install.sh section 5b.
CP_STATE="$DEPLO_DIR/.install-state"
takeover_state() { [ -f "$CP_STATE" ] && sed -n "s/^takeover=//p" "$CP_STATE" | tail -n1 || true; }
takeover_platform() { [ -f "$CP_STATE" ] && sed -n "s/^takeover_platform=//p" "$CP_STATE" | tail -n1 || true; }
TAKEOVER="$(takeover_platform)"
TAKEOVER_STATE="$(takeover_state)"

# ==== Deplo terminal UI ===================================== KEEP IN SYNC ====
# One renderer for install.sh, install-agent.sh and uninstall.sh. It degrades on
# purpose: no TTY, NO_COLOR, TERM=dumb or a non-UTF-8 locale drops to plain ASCII
# carrying the same words, because installer output is what people paste into a
# bug report. Everything printed also lands in $UI_LOG, stripped of escapes.

UI_COLOR=0; UI_UNICODE=0; UI_TTY=0; UI_QUIET=0; UI_DEPTH=256
UI_LOG="${DEPLO_LOG_FILE:-/var/log/deplo-uninstall.log}"
UI_PHASE=""; UI_T0=0; UI_ACTION="uninstall"
# The transcript gets EVERYTHING: every command bash runs, and the output of each
# one - apt, docker, systemd, curl. DEPLO_TRACE=0 keeps only the output.
UI_TRACE="${DEPLO_TRACE:-1}"

ui_init() {
  [ -t 1 ] && UI_TTY=1
  UI_COLOR=$UI_TTY
  [ -n "${NO_COLOR:-}" ] && UI_COLOR=0
  case "${TERM:-}" in dumb) UI_COLOR=0 ;; esac
  case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in *[Uu][Tt][Ff]*8*) UI_UNICODE=1 ;; esac
  if [ "${UI_FORCE_PLAIN:-0}" = 1 ]; then UI_COLOR=0; UI_UNICODE=0; fi
  [ "${UI_FORCE_NOCOLOR:-0}" = 1 ] && UI_COLOR=0

  C_OFF=""; C_B=""; C_DIM=""; C_OK=""; C_WARN=""; C_ERR=""; C_ACC=""
  if [ "$UI_COLOR" = 1 ]; then
    case "${COLORTERM:-}" in
      truecolor|24bit) UI_DEPTH=16777216 ;;
      *) UI_DEPTH="$(tput colors 2>/dev/null || echo 8)" ;;
    esac
    case "$UI_DEPTH" in *[!0-9]*|"") UI_DEPTH=8 ;; esac
    C_OFF=$'\033[0m'; C_B=$'\033[1m'; C_DIM=$'\033[2m'
    C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_ERR=$'\033[31m'; C_ACC=$'\033[36m'
    if [ "$UI_DEPTH" -ge 256 ]; then
      C_ACC=$'\033[38;5;75m'; C_DIM=$'\033[38;5;244m'
    fi
  fi

  if [ "$UI_UNICODE" = 1 ]; then
    G_OK="✔"; G_WARN="!"; G_ERR="✖"; G_SKIP="·"; G_STEP="›"; G_ARROW="→"; G_BAR="▌"
    G_TL="╭"; G_TR="╮"; G_BL="╰"; G_BR="╯"; G_H="─"; G_V="│"
    UI_SPIN="⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏"
  else
    G_OK="ok"; G_WARN=" !"; G_ERR="!!"; G_SKIP="--"; G_STEP=".."; G_ARROW="->"; G_BAR="=="
    G_TL="+"; G_TR="+"; G_BL="+"; G_BR="+"; G_H="-"; G_V="|"
    UI_SPIN="| / - \\"
  fi
  UI_SPIN_DELAY=0.08
  sleep 0.08 2>/dev/null || UI_SPIN_DELAY=1

  UI_W="$( { [ "$UI_TTY" = 1 ] && tput cols; } 2>/dev/null || echo 80)"
  [ "${UI_W:-0}" -lt 40 ] 2>/dev/null && UI_W=80
  [ "$UI_W" -gt 84 ] && UI_W=84

  UI_T0=$SECONDS
  # fd 9 IS the transcript, for the trace and for every command redirected to it.
  # 0600 before a single byte is written: it carries whatever the commands print.
  if : >>"$UI_LOG" 2>/dev/null; then
    chmod 600 "$UI_LOG" 2>/dev/null || true
    exec 9>>"$UI_LOG"
  else
    UI_LOG=/dev/null
    exec 9>/dev/null
  fi
  ui_log "=== Deplo $UI_ACTION $(date -u '+%Y-%m-%dT%H:%M:%SZ') - args: $* ==="
  ui_log "=== $(uname -srm) - $(id -un)@$(hostname 2>/dev/null || echo '?') ==="
  [ "${UI_TRACE:-1}" = 1 ] && ui_log "=== every command is traced; grep -v '^+' for command output only ==="
  # No `date` in PS4: it would fork once per traced command. Elapsed seconds is
  # the number you actually want when reading back a slow install.
  # `curl | bash` has no source FILE, so `$BASH_SOURCE` is unset - and under
  # `set -u` expanding it in PS4 kills the script at the first traced command,
  # which is the way this installer is normally run.
  UI_SRC="${BASH_SOURCE[0]:-stdin}"
  PS4="+ \${SECONDS}s ${UI_SRC##*/}:\${LINENO}: "
  # Without this the trace goes to stderr, i.e. over the top of the interface.
  BASH_XTRACEFD=9
  trace_on
}

# Tracing goes quiet around anything holding a secret. The file is 0600 root-only,
# but a transcript gets tarred up and pasted into an issue, and DEPLO_SECRET
# decrypts every backup this instance ever wrote.
trace_off() { set +x; }
trace_on() { [ "${UI_TRACE:-1}" = 1 ] && set -x; return 0; }

ui_log() { printf '%s\n' "$*" >&9 2>/dev/null || true; }

# Marker + message, the one line shape every status in this script uses.
ui_line() { # $1 colour  $2 glyph  $3 text  $4 suffix  $5 non-empty = print even when quiet
  local suffix=""
  [ -n "${4:-}" ] && suffix=" ${C_DIM}${4}${C_OFF}"
  ui_log "  [${2}] ${3}${4:+  ${4}}"
  { [ "$UI_QUIET" = 1 ] && [ -z "${5:-}" ]; } && return 0
  if [ "$UI_UNICODE" = 1 ]; then printf '  %b%s%b %s%b\n' "$1" "$2" "$C_OFF" "$3" "$suffix"
  else printf '  %b[%s]%b %s%b\n' "$1" "$2" "$C_OFF" "$3" "$suffix"; fi
}

ok()   { ui_line "$C_OK"   "$G_OK"   "$1" "${2:-}"; }
warn() { ui_line "$C_WARN" "$G_WARN" "$1" "${2:-}" force; }
step() { ui_line "$C_ACC"  "$G_STEP" "$1" "${2:-}"; }
skip() { ui_line "$C_DIM"  "$G_SKIP" "$1" "${2:-}"; }
err()  {
  ui_log "  [!!] $1"
  if [ "$UI_UNICODE" = 1 ]; then printf '  %b%s%b %s\n' "$C_ERR" "$G_ERR" "$C_OFF" "$1" >&2
  else printf '  %b[!!]%b %s\n' "$C_ERR" "$C_OFF" "$1" >&2; fi
}
# Indented to land exactly under the message it explains, in both glyph sets.
note() {
  ui_log "      $1"
  [ "$UI_QUIET" = 1 ] && return 0
  local ind="    "
  [ "$UI_UNICODE" = 1 ] || ind="       "
  printf '%s%b%s%b\n' "$ind" "$C_DIM" "$1" "$C_OFF"
}
blank() { [ "$UI_QUIET" = 1 ] || printf '\n'; ui_log ""; }

phase() {
  UI_PHASE="$1"
  ui_log ""; ui_log "-- $1 --"
  [ "$UI_QUIET" = 1 ] && return 0
  printf '\n %b%s%b %b%s%b\n' "$C_ACC" "$G_BAR" "$C_OFF" "$C_B" "$1" "$C_OFF"
}

# --- the header ---------------------------------------------------------------
# What is running, which version of it, and one line telling a first-time reader
# what is about to happen to their machine.
ui_title() {
  [ "$UI_QUIET" = 1 ] && return 0
  ui_log "== $1 =="
  printf '\n %b%s%b\n' "$C_B" "$1" "$C_OFF"
  if [ -n "${2:-}" ]; then
    ui_log "   $2"
    printf ' %b%s%b\n' "$C_DIM" "$2" "$C_OFF"
  fi
  return 0
}

# --- spinner ------------------------------------------------------------------
UI_SPIN_PID=""; UI_SPIN_MSG=""; UI_SPIN_T0=0

spin_start() {
  UI_SPIN_MSG="$1"; UI_SPIN_T0=$SECONDS
  ui_log "  [..] $1"
  if [ "$UI_TTY" != 1 ] || [ "$UI_QUIET" = 1 ]; then
    [ "$UI_QUIET" = 1 ] || step "$1"
    return 0
  fi
  printf '\033[?25l'
  (
    set +x                     # 12 traced lines a second, otherwise
    trap 'exit 0' TERM INT
    frames=($UI_SPIN); n=${#frames[@]}; i=0
    while :; do
      printf '\r\033[2K  %b%s%b %s' "$C_ACC" "${frames[$((i % n))]}" "$C_OFF" "$UI_SPIN_MSG"
      i=$((i + 1)); sleep "$UI_SPIN_DELAY"
    done
  ) & UI_SPIN_PID=$!
}

spin_kill() {
  [ -n "$UI_SPIN_PID" ] || return 0
  kill "$UI_SPIN_PID" 2>/dev/null || true
  wait "$UI_SPIN_PID" 2>/dev/null || true
  UI_SPIN_PID=""
  [ "$UI_TTY" = 1 ] && printf '\r\033[2K\033[?25h'
  return 0
}

# Elapsed time, shown only once it is worth reading.
spin_elapsed() {
  local d=$(( SECONDS - UI_SPIN_T0 ))
  [ "$d" -ge 2 ] && printf '%ds' "$d"
  return 0
}

spin_ok()   { local e; e="$(spin_elapsed)"; spin_kill; ok   "${1:-$UI_SPIN_MSG}" "$e"; }
spin_warn() { local e; e="$(spin_elapsed)"; spin_kill; warn "${1:-$UI_SPIN_MSG}" "$e"; }
spin_err()  { spin_kill; err "${1:-$UI_SPIN_MSG}"; }

# Run a command under the spinner, its output going to the transcript only.
# `</dev/null` on purpose: this script may itself be arriving on stdin.
spin_run() {
  local msg="$1"; shift
  spin_start "$msg"
  if "$@" >&9 2>&9 </dev/null; then spin_ok; return 0; fi
  spin_err "$msg"
  return 1
}

# --- summary card -------------------------------------------------------------
ui_pad() { local s="$1" n="$2"; printf '%s' "$s"; local i=${#s}; while [ "$i" -lt "$n" ]; do printf ' '; i=$((i + 1)); done; }
ui_rule() { local n="$1" i=0; while [ "$i" -lt "$n" ]; do printf '%s' "$G_H"; i=$((i + 1)); done; }

card_open() {
  CARD_W=$(( UI_W - 4 ))
  ui_log ""; ui_log "== $1 =="
  [ "$UI_QUIET" = 1 ] && return 0
  local title=" $1 "
  printf '\n %b%s%s%b' "$C_ACC" "$G_TL" "$G_H" "$C_OFF"
  printf '%b%s%b' "$C_B" "$title" "$C_OFF"
  printf '%b%s%s%b\n' "$C_ACC" "$(ui_rule $(( CARD_W - ${#title} - 1 )))" "$G_TR" "$C_OFF"
}

card_kv() {
  ui_log "   $1  $2"
  [ "$UI_QUIET" = 1 ] && return 0
  local key val body pad max
  key="$(ui_pad "$1" 11)"
  val="$2"
  # Truncate rather than let a long value push the right border off the row: a
  # box that only sometimes closes reads as a rendering bug, not as information.
  max=$(( CARD_W - 13 ))
  if [ "${#val}" -gt "$max" ] && [ "$max" -gt 1 ]; then
    if [ "$UI_UNICODE" = 1 ]; then val="${val:0:$((max - 1))}…"; else val="${val:0:$((max - 3))}..."; fi
  fi
  body="  ${key}${val}"
  pad=$(( CARD_W - ${#body} ))
  [ "$pad" -lt 0 ] && pad=0
  printf ' %b%s%b  %b%s%b%s%s%b%s%b\n' \
    "$C_ACC" "$G_V" "$C_OFF" \
    "$C_DIM" "$key" "$C_OFF" "$val" \
    "$(ui_pad "" "$pad")" "$C_ACC" "$G_V" "$C_OFF"
}

card_close() {
  [ "$UI_QUIET" = 1 ] && return 0
  printf ' %b%s%s%s%b\n\n' "$C_ACC" "$G_BL" "$(ui_rule "$CARD_W")" "$G_BR" "$C_OFF"
}

ui_cleanup() { spin_kill; [ "$UI_TTY" = 1 ] && printf '\033[?25h'; return 0; }

# "1 warning" / "2 warnings" - a count the reader has to decode is a count that
# looks machine-generated.
plural() {
  if [ "$1" = 1 ]; then printf '%s' "$2"; else printf '%s%s' "$2" "${3:-s}"; fi
}

UI_ERR_SEEN=0
on_err() {
  local code=$? line="${1:-?}"
  [ "$UI_ERR_SEEN" = 1 ] && exit "$code"
  UI_ERR_SEEN=1
  spin_kill
  blank
  err "The ${UI_ACTION:-install} failed${UI_PHASE:+ during: $UI_PHASE} (line $line, exit $code)."
  [ "$UI_LOG" = /dev/null ] || note "Full transcript: $UI_LOG"
  note "Re-running this script picks up where it stopped."
  exit "$code"
}
# ==== end Deplo terminal UI ==================================================

APPLY=false
PURGE=false
PURGE_BACKUPS=false
# One line, one token, on purpose: the control plane serves this script at the
# legacy /uninstall-agent.sh URL with this flipped to `true`, so a one-liner
# copied into a runbook before uninstall.sh existed keeps meaning exactly what it
# meant then - remove the agent, leave the panel alone.
AGENT_ONLY=false

usage() {
  ui_title "Deplo Uninstaller"
  printf ' %bUsage%b\n' "$C_B" "$C_OFF"
  printf '   curl -fsSL https://<deplo>/uninstall.sh | sudo bash -s -- --yes\n\n'
  printf ' %bFlags%b\n' "$C_B" "$C_OFF"
  printf '   (none)           print exactly what would be removed, change nothing\n'
  printf '   --yes            actually do it\n'
  printf '   --agent-only     leave the control plane alone and remove only this\n'
  printf '                    host'"'"'s agent, its Traefik and the containers Deplo\n'
  printf '                    deployed here - what you run on a server you have\n'
  printf '                    just removed from the fleet in the dashboard\n'
  printf '   --purge-data     ALSO delete app/database volumes, images Deplo built,\n'
  printf '                    the stacks directory and /opt/deplo - which holds .env,\n'
  printf '                    and .env holds DEPLO_SECRET. IRREVERSIBLE.\n'
  printf '   --purge-backups  ALSO delete every backup artifact stored on this host.\n'
  printf '                    IRREVERSIBLE, and those are the last copies.\n'
  printf '   --plain          ASCII output, no colour\n'
  printf '   --no-color       colour off, keep the rest\n'
  printf '   --help\n\n'
}

WANT_HELP=false
for arg in "$@"; do
  case "$arg" in
    --yes|-y)        APPLY=true ;;
    --agent-only)    AGENT_ONLY=true ;;
    --purge-data)    PURGE=true ;;
    --purge-backups) PURGE_BACKUPS=true ;;
    --plain)         UI_FORCE_PLAIN=1 ;;
    --no-color)      UI_FORCE_NOCOLOR=1 ;;
    --help|-h)       WANT_HELP=true ;;
    *)
      ui_init
      err "Unknown flag '$arg'."
      note "--yes to execute, --agent-only to keep the control plane,"
      note "--purge-data / --purge-backups to also delete data, --help."
      exit 1
      ;;
  esac
done

ui_init
trap 'ui_cleanup' EXIT
trap 'spin_kill; printf "\n"; exit 130' INT
trap 'on_err $LINENO' ERR

$WANT_HELP && { usage; exit 0; }

if [ "$(id -u)" -ne 0 ]; then
  ui_title "Deplo Uninstaller"
  err "Removing system services needs root."
  note "Re-run it with sudo."
  exit 1
fi

# Past-tense, and only ever printed when something actually happened. In a dry
# run the printed `$ command` lines already say what WOULD happen - claiming
# "removed" there would be the same kind of lie this script exists to correct.
applied() { [ "$APPLY" = true ] && ok "$1"; return 0; }

# In dry-run every mutation is printed instead of executed, so the operator sees
# the exact commands before authorizing them. Everything below goes through run().
run() {
  if [ "$APPLY" = true ]; then
    "$@" >&9 2>&9 </dev/null || true
  else
    ui_log "     $ $*"
    [ "$UI_QUIET" = 1 ] || printf '     %b$ %s%b\n' "$C_DIM" "$*" "$C_OFF"
  fi
}

HAVE_DOCKER=false
command -v docker >/dev/null 2>&1 && HAVE_DOCKER=true

if [ "$AGENT_ONLY" = true ]; then
  ui_title "Deplo Uninstaller - this host's agent only" \
    "Removes this host's Deplo agent and what it runs. The dashboard is left alone."
elif [ "$APPLY" = true ]; then
  ui_title "Deplo Uninstaller" \
    "Removes Deplo from this machine. Your data stays unless you pass --purge-data."
else
  ui_title "Deplo Uninstaller" \
    "Shows exactly what would be removed. Nothing changes without --yes."
fi

# ==============================================================================
# 0. What is actually here
# ==============================================================================
# A destructive tool that opens by naming what it found is a different tool from
# one that opens by asking for confirmation of an abstraction.
phase "Found on this host"

if [ -n "$TAKEOVER" ] && [ "$TAKEOVER_STATE" != removed ]; then
  ok "This Deplo was replacing $TAKEOVER" "still on this machine, untouched"
fi

INV_CP=false; INV_AGENT=false
[ -f "$CP_COMPOSE" ] && INV_CP=true
{ [ -f "$UNIT" ] || [ -f "$AGENT_BIN" ]; } && INV_AGENT=true

if [ "$INV_CP" = true ]; then ok "Deplo control plane" "$DEPLO_DIR"; else skip "No Deplo control plane"; fi
if [ "$INV_AGENT" = true ]; then ok "Deplo server agent" "$AGENT_DATA"; else skip "No server agent"; fi

MANAGED_N=0
VOL_N=0
if [ "$HAVE_DOCKER" = true ]; then
  MANAGED_N="$(docker ps -aq --filter label=deplo.managed=true 2>/dev/null | wc -l | tr -d ' ' || true)"
  VOL_N="$(docker volume ls -q 2>/dev/null | grep -cE '^deplo' || true)"
  if [ "${MANAGED_N:-0}" -gt 0 ]; then ok "$MANAGED_N container(s) Deplo deployed here"; else skip "No containers Deplo deployed here"; fi
  if [ "${VOL_N:-0}" -gt 0 ]; then ok "$VOL_N Deplo volume(s)" "your apps' and databases' data"; fi
else
  skip "Docker is not installed on this host"
fi

BACKUP_SZ=""
if [ -d /data/backups ]; then
  BACKUP_SZ="$(du -sh /data/backups 2>/dev/null | awk '{print $1}' || true)"
  ok "Backup artifacts" "/data/backups${BACKUP_SZ:+, $BACKUP_SZ}"
fi

blank
if [ "$APPLY" = true ]; then
  if [ "$AGENT_ONLY" = true ]; then
    warn "Removing the Deplo agent from this host."
  else
    warn "Removing Deplo from this host."
  fi
else
  step "DRY RUN - nothing will be changed."
  note "These are the commands that --yes would run."
fi

# ==============================================================================
# 1. The control plane
# ==============================================================================
# First, and by `compose down` rather than `docker rm`: the panel and its
# Postgres must be stopped before Traefik and the `deplo` network go away under
# them. Skipped entirely with --agent-only.
phase "Control plane"

if [ "$AGENT_ONLY" = true ]; then
  if [ -f "$CP_COMPOSE" ]; then
    warn "--agent-only: the control plane in $DEPLO_DIR stays. Its Traefik does not -"
    note "the panel keeps answering on :3000, and re-running install.sh brings :80/:443 back."
  else
    skip "No Deplo control plane on this host"
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
  applied "Control plane stopped"
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
    applied "Control-plane containers removed"
  else
    skip "No Deplo control plane on this host"
  fi
else
  skip "No Deplo control plane on this host"
fi

# ==============================================================================
# 2. The agent service
# ==============================================================================
# Stop it FIRST: while it lives, systemd restarts it (Restart=on-failure) and it
# keeps holding the docker socket.
phase "Server agent"

if [ -f "$UNIT" ] || systemctl list-unit-files deplo-agent.service >/dev/null 2>&1; then
  step "Stopping and disabling the deplo-agent service"
  run systemctl disable --now deplo-agent
  run rm -f "$UNIT"
  run systemctl daemon-reload
  applied "Agent service removed"
else
  skip "No deplo-agent service on this host"
fi

if [ -f "$AGENT_BIN" ]; then
  step "Removing the agent binary"
  run rm -f "$AGENT_BIN"
  applied "$AGENT_BIN removed"
else
  skip "No agent binary at $AGENT_BIN"
fi

# ==============================================================================
# 3. Containers Deplo runs on this host
# ==============================================================================
phase "Containers and networks"

# Deplo stopped the other panel to take its ports; leaving it stopped would hand
# back a machine serving nothing. The route Deplo dropped into its proxy goes too.
if [ -n "$TAKEOVER" ] && [ "$TAKEOVER_STATE" != removed ] && [ "$HAVE_DOCKER" = true ]; then
  FOREIGN="$(docker ps -aq --filter "name=^${TAKEOVER}" 2>/dev/null || true)"
  if [ -n "$FOREIGN" ]; then
    step "Starting $TAKEOVER again - it owned this machine before Deplo"
    # shellcheck disable=SC2086 # word splitting is the point: one id per arg
    run docker update --restart=unless-stopped $FOREIGN
    # shellcheck disable=SC2086
    run docker start $FOREIGN
  fi
  for f in /etc/dokploy/traefik/dynamic/deplo-setup.yml /data/coolify/proxy/dynamic/deplo-setup.yml; do
    if [ -f "$f" ]; then
      step "Removing the setup route Deplo added to $TAKEOVER"
      run rm -f "$f"
    fi
  done
fi

if [ "$HAVE_DOCKER" = true ]; then
  # Traefik first, via its compose file when we still have it, so the network is
  # left detached and the sweep below can drop it. On the control-plane host
  # $TRAEFIK_DIR is a symlink into /opt/deplo/traefik, which step 1 already took
  # down - `compose down` on a stopped project is a no-op, not an error.
  if [ -f "$TRAEFIK_DIR/docker-compose.yml" ]; then
    step "Stopping Traefik (deplo-traefik)"
    run docker compose -f "$TRAEFIK_DIR/docker-compose.yml" down
  fi
  for c in "${NAMED_CONTAINERS[@]}"; do
    if docker ps -aq --filter "name=^${c}$" | grep -q .; then
      step "Removing $c"
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
  applied "Deplo containers and networks removed"
else
  skip "Docker is not installed - no containers or networks to remove"
fi

# ==============================================================================
# 4. Agent state
# ==============================================================================
phase "Agent state"

# Takes the mTLS materials AND the Traefik acme.json (issued certificates) with
# it. Called out explicitly because Let's Encrypt rate-limits re-issuance. On the
# control-plane host $AGENT_DATA/traefik is a SYMLINK into /opt/deplo, so this
# removes the link and never the certificates behind it.
if [ -d "$AGENT_DATA" ]; then
  step "Removing $AGENT_DATA (mTLS certs + Traefik's acme.json)"
  run rm -rf "$AGENT_DATA"
  applied "Agent state removed"
else
  skip "No agent state at $AGENT_DATA"
fi

# ==============================================================================
# 5. Data - ONLY with --purge-data
# ==============================================================================
if [ "$PURGE" = true ]; then
  phase "Purging data"
  err "--purge-data: deleting volumes, images and data. This is irreversible."
  if [ "$AGENT_ONLY" != true ]; then
    err "$DEPLO_DIR/.env goes with it, and that file holds DEPLO_SECRET -"
    err "without it no backup artifact of this instance can ever be decrypted."
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
      step "Removing $(printf '%s\n' "$VOLS" | wc -l | tr -d ' ') Deplo volume(s)"
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
  step "Removing the stacks and dev directories"
  run rm -rf /data/stacks /data/dev
  if [ "$AGENT_ONLY" != true ] && [ -d "$DEPLO_DIR" ]; then
    step "Removing $DEPLO_DIR (.env with DEPLO_SECRET, the panel's data, acme.json)"
    run rm -rf "$DEPLO_DIR"
  fi
  applied "Data purged"
fi

# ==============================================================================
# 6. Backups - ONLY with --purge-backups
# ==============================================================================
# Its own flag rather than part of --purge-data: everything above can be rebuilt
# from a backup, and these ARE the backups.
if [ "$PURGE_BACKUPS" = true ]; then
  if [ -d /data/backups ]; then
    phase "Purging backups"
    err "--purge-backups: deleting the last copy of this host's data${BACKUP_SZ:+ ($BACKUP_SZ)}."
    step "Removing the backup store"
    run rm -rf /data/backups
    applied "Backups purged"
  else
    skip "No backups on this host"
  fi
fi

# ==============================================================================
# 7. What we deliberately left behind
# ==============================================================================
if [ "$APPLY" = true ]; then
  if [ "$AGENT_ONLY" = true ]; then
    card_open "This host is no longer a Deplo server"
  else
    card_open "Deplo is off this machine"
  fi
else
  card_open "Dry run finished - nothing was changed"
fi
card_kv "Kept" "Docker Engine, and every container Deplo did not label"
card_kv "Kept" "/etc/docker/daemon.json (original: daemon.json.deplo-bak)"
if [ "$PURGE" != true ]; then
  if [ "$AGENT_ONLY" = true ]; then
    card_kv "Kept" "every deplo-* volume and image - your apps' and databases' DATA"
  else
    card_kv "Kept" "deplo-* volumes, images, $DEPLO_DIR - DATA and DEPLO_SECRET"
  fi
fi
[ "$PURGE_BACKUPS" != true ] && [ -d /data/backups ] && card_kv "Kept" "the backup store${BACKUP_SZ:+, $BACKUP_SZ}"
card_close

if [ "$APPLY" != true ]; then
  printf ' Re-run with %b--yes%b to execute.\n\n' "$C_B" "$C_OFF"
else
  note "Docker Engine stayed: Deplo installed it, but other things may use it now."
  note "Putting the address pools back needs a Docker restart, which stops every"
  note "container on this machine, so that one is your call."
  if [ "$PURGE" != true ]; then
    note "Re-run with --purge-data to delete the data too (irreversible)."
  fi
  if [ "$PURGE_BACKUPS" != true ] && [ -d /data/backups ]; then
    note "Re-run with --purge-backups to delete the backup store (irreversible)."
  fi
  printf '\n'
fi
