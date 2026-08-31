#!/usr/bin/env bash
#
# Deplo SERVER-AGENT installer. Run on a Linux host to turn it into a Deplo
# server: installs Docker (if absent) + the `deplo-agent` binary, writes a
# systemd unit, and starts the agent in BOOTSTRAP mode. The agent then generates
# its own key, sends a CSR to the control plane, gets a signed cert, and starts
# serving - at which point the server flips to "online" in the dashboard. The
# control plane NEVER SSHes into this box; the agent connects out.
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
# Flags, anywhere among the args: --check (preflight only), --force (install even
# if the preflight failed), --plain, --no-color, --quiet, --help.
#
# The agent binary ships as a GitHub Release asset (DeploCloud/deplo-agent).
# The control plane serves this script over its own domain and substitutes the
# release's per-arch download URL + sha256 below (read from the release's
# checksums.txt at serve time) - the script REFUSES to run a binary whose
# checksum does not match (P2), even though the bytes come from github.com.
set -Eeuo pipefail

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

# ==== deplo terminal UI ===================================== KEEP IN SYNC ====
# One renderer for install.sh, install-agent.sh and uninstall.sh. It degrades on
# purpose: no TTY, NO_COLOR, TERM=dumb or a non-UTF-8 locale drops to plain ASCII
# carrying the same words, because installer output is what people paste into a
# bug report. Everything printed also lands in $UI_LOG, stripped of escapes.

UI_COLOR=0; UI_UNICODE=0; UI_TTY=0; UI_QUIET=0; UI_DEPTH=256
UI_LOG="${DEPLO_LOG_FILE:-/var/log/deplo-agent-install.log}"
UI_PHASE=""; UI_T0=0; UI_ACTION="install"
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
  ui_log "=== deplo $UI_ACTION $(date -u '+%Y-%m-%dT%H:%M:%SZ') - args: $* ==="
  ui_log "=== $(uname -srm) - $(id -un)@$(hostname 2>/dev/null || echo '?') ==="
  [ "${UI_TRACE:-1}" = 1 ] && ui_log "=== every command is traced; grep -v '^+' for command output only ==="
  # No `date` in PS4: it would fork once per traced command. Elapsed seconds is
  # the number you actually want when reading back a slow install.
  PS4='+ ${SECONDS}s ${BASH_SOURCE##*/}:${LINENO}: '
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
# ==== end deplo terminal UI ==================================================

# --- args ---------------------------------------------------------------------
# Flags are filtered out so the three positionals keep their places: the panel
# hands out `bash -s -- <token> <url> [fingerprint]` and that command must never
# have to change shape.
CHECK_ONLY=false
FORCE=false
ARGS=()
for a in "$@"; do
  case "$a" in
    --check)     CHECK_ONLY=true ;;
    --force)     FORCE=true ;;
    --plain)     UI_FORCE_PLAIN=1 ;;
    --no-color)  UI_FORCE_NOCOLOR=1 ;;
    --quiet|-q)  UI_QUIET=1 ;;
    --help|-h)
      ui_init
      ui_title "Deplo Agent Installer"
      printf '   curl -fsSL https://<deplo>/install-agent.sh | sudo bash -s -- <TOKEN> <URL>\n\n'
      printf '   Copy the exact command from the dashboard: Settings > Servers > Add server.\n\n'
      exit 0
      ;;
    *) ARGS+=("$a") ;;
  esac
done

ui_init
trap 'ui_cleanup' EXIT
trap 'spin_kill; printf "\n"; exit 130' INT
trap 'on_err $LINENO' ERR

trace_off                        # the one-time bootstrap token
TOKEN="${ARGS[0]:-}"
URL="${ARGS[1]:-}"
FINGERPRINT="${ARGS[2]:-}"
trace_on

HOST_ROLE="server"
[ "$STORAGE_ONLY" = "1" ] && HOST_ROLE="storage-only server"
[ "$BUILD_ONLY" = "1" ] && HOST_ROLE="build server"
[ "$IMPORT_ONLY" = "1" ] && HOST_ROLE="migration source"

# The role rides in the title: on a storage-only or build-only box it changes
# what this script does, so it is not a detail to leave for the summary. And the
# line under it says, in the reader's terms, what this machine becomes.
case "$AGENT_VERSION" in
  [0-9]*) AGENT_TITLE="Deplo Agent Installer - v$AGENT_VERSION" ;;
  *)      AGENT_TITLE="Deplo Agent Installer" ;;      # the unsubstituted template
esac
case "$HOST_ROLE" in
  "build server")        ROLE_LINE="Turns this machine into a build server: it builds images, it runs nothing." ;;
  "storage-only server") ROLE_LINE="Turns this machine into a backup store for Deplo. Nothing is deployed here." ;;
  "migration source")    ROLE_LINE="Installs a read-only agent so Deplo can import this host's volumes." ;;
  *)                     ROLE_LINE="Turns this machine into a Deplo server, so you can deploy apps to it." ;;
esac
[ "$HOST_ROLE" = server ] || AGENT_TITLE="$AGENT_TITLE ($HOST_ROLE)"
ui_title "$AGENT_TITLE" "$ROLE_LINE"

if [ -z "$TOKEN" ] || [ -z "$URL" ]; then
  err "Usage: install-agent.sh -- <token> <control-plane-url> [fingerprint]"
  note "Copy the exact command from the dashboard's Add remote server dialog."
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
    note "which fills in the binary URL + checksum. Don't run the repo copy directly."
    exit 1
    ;;
esac

# ==============================================================================
# 0. Preflight
# ==============================================================================
# Everything knowable before the host is touched. The expensive mistake this
# catches is a control plane that cannot be reached: the agent would install
# cleanly, call home into the void, and the server would sit at "offline"
# forever with nothing on this box saying why.
phase "Preflight"

PF_FAIL=0
PF_WARN=0
pf_fail() { PF_FAIL=$((PF_FAIL + 1)); err "$1"; [ -n "${2:-}" ] && note "$2"; return 0; }
pf_warn() { PF_WARN=$((PF_WARN + 1)); warn "$1"; [ -n "${2:-}" ] && note "$2"; return 0; }

if [ "$(id -u)" -ne 0 ]; then
  err "The agent is a system service, so this has to run as root."
  note "Copy the command from the dashboard - it already carries sudo."
  exit 1
fi

OS_NAME="$( . /etc/os-release 2>/dev/null && printf '%s %s' "${NAME:-Linux}" "${VERSION_ID:-}" || true )"
case "$(uname -m)" in
  x86_64|amd64|aarch64|arm64) ok "${OS_NAME:-Linux} on $(uname -m)" ;;
  *) pf_fail "Unsupported architecture '$(uname -m)'." "The Deplo agent ships linux/amd64 and linux/arm64 only." ;;
esac

MISSING=""
for bin in curl sha256sum systemctl; do
  command -v "$bin" >/dev/null 2>&1 || MISSING="$MISSING $bin"
done
if [ -n "$MISSING" ]; then
  pf_fail "Missing required tool(s):$MISSING." "Install them with this system's package manager and re-run."
else
  ok "curl, sha256sum and systemd present"
fi

DISK_GB="$(df -PBG / 2>/dev/null | awk 'NR==2 {gsub("G","",$4); print $4}' || true)"
if [ "${DISK_GB:-0}" -ge 20 ]; then ok "Disk: ${DISK_GB} GB free on /"
elif [ "${DISK_GB:-0}" -ge 5 ]; then pf_warn "${DISK_GB} GB free on /." "Images and build caches grow fast; 20 GB is the comfortable floor."
else pf_fail "Only ${DISK_GB:-0} GB free on /." "Free some space and re-run."; fi

# The control plane, before anything is installed ------------------------------
case "$URL" in
  http://*|https://*) : ;;
  *) pf_fail "'$URL' is not a control-plane URL." "It must start with http:// or https://. Copy the command from the dashboard." ;;
esac
# The status code, not `curl -f`: "nothing answered" and "answered, but not with
# a healthy panel" send the operator to two different places, and collapsing them
# into one message costs an hour of looking at the wrong thing. %{http_code} is
# 000 only when no HTTP response came back at all.
spin_start "Reaching the control plane at $URL"
CP_CODE="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$URL/api/health" </dev/null 2>&9 || true)"
ui_log "  reach $URL/api/health -> ${CP_CODE:-none}"
case "${CP_CODE:-000}" in
  2*) spin_ok "Control plane reachable at $URL" ;;
  "" | 000)
    spin_kill
    pf_fail "Cannot reach $URL from this host." \
      "The agent provisions itself by calling out to that address. Check DNS, egress and any firewall."
    ;;
  *)
    spin_kill
    pf_fail "$URL answered HTTP $CP_CODE, which is not a healthy control plane." \
      "The address is reachable, so check it is the panel's own URL and that the panel has finished starting."
    ;;
esac

# Docker, per role -------------------------------------------------------------
if [ "$STORAGE_ONLY" = "1" ]; then
  skip "Storage-only server: Docker is not needed here"
elif command -v docker >/dev/null 2>&1; then
  if docker info >/dev/null 2>&1; then ok "Docker $(docker --version 2>/dev/null | awk '{print $3}' | tr -d ,), daemon responding"
  else pf_fail "Docker is installed but its daemon is not answering." "Start it: systemctl start docker"; fi
elif [ "$IMPORT_ONLY" = "1" ]; then
  pf_fail "Docker is not installed on this host, so there are no volumes to import."
else
  step "Docker is not installed - the installer will add it"
fi

# The port the panel dials ------------------------------------------------------
# Outbound provisioning succeeds either way, so a blocked port reads as a server
# that enrolls and then never comes online. Say it now, not at the end.
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
if [ -n "$FIREWALL_FIX" ]; then
  pf_warn "This host's firewall is blocking TCP $AGENT_PORT, which Deplo dials." "Open it with:  $FIREWALL_FIX"
else
  ok "TCP $AGENT_PORT is not blocked by this host's firewall"
fi

blank
if [ "$PF_FAIL" -gt 0 ]; then
  err "Preflight found $PF_FAIL blocking $(plural "$PF_FAIL" problem) and $PF_WARN $(plural "$PF_WARN" warning)."
  if [ "$CHECK_ONLY" != true ] && [ "$FORCE" != true ]; then
    note "Fix them and re-run, or pass --force to install the agent anyway."
    exit 1
  fi
elif [ "$PF_WARN" -gt 0 ]; then
  warn "Preflight passed with $PF_WARN $(plural "$PF_WARN" warning)."
else
  ok "Preflight passed."
fi
if [ "$CHECK_ONLY" = true ]; then
  blank
  note "Nothing was changed. Re-run without --check to install the agent."
  exit $([ "$PF_FAIL" -gt 0 ] && echo 1 || echo 0)
fi

# ==============================================================================
# 1. Docker
# ==============================================================================
phase "Docker"

if [ "$STORAGE_ONLY" = "1" ]; then
  skip "Storage-only server: skipping Docker"
elif [ "$IMPORT_ONLY" = "1" ]; then
  # Docker has to be here already - this is the other platform's host, and its
  # volumes are what we came to read. Installing it would be changing a machine we
  # are only borrowing.
  ok "Migration source: using the Docker already on this host"
elif ! command -v docker >/dev/null 2>&1; then
  spin_start "Installing Docker"
  if curl -fsSL https://get.docker.com </dev/null 2>&9 | sh >&9 2>&9; then
    systemctl enable --now docker >&9 2>&9 || true
    spin_ok "Docker installed ($(docker --version 2>/dev/null | awk '{print $3}' | tr -d ,))"
  else
    spin_err "Docker installation failed"
    note "Transcript: $UI_LOG"
    exit 1
  fi
else
  ok "Docker already installed"
fi

# 1a. git --------------------------------------------------------------------
# The agent clones repositories with the HOST's git. Without it every app that
# deploys from a repo fails with `exec: "git": executable file not found`, and the
# only way out would be an SSH session - which is the thing Deplo exists to avoid.
ensure_git() {
  command -v git >/dev/null 2>&1 && { ok "git already installed"; return; }
  spin_start "Installing git"
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
  } >&9 2>&9 </dev/null || true
  if command -v git >/dev/null 2>&1; then
    spin_ok "git installed"
  else
    spin_warn "Could not install git"
    note "Apps that deploy from a repository will not build until it is there."
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
#   1. NEVER hardcode the whole of the 10 range - it swallows the host's own
#      LAN/VPN and dockerd then refuses to start. Pick a /13 overlapping NO route.
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
     && ! dockerd --validate --config-file="$TMP" >&9 2>&9; then
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
  systemctl restart docker >&9 2>&9 || true
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
    systemctl restart docker >&9 2>&9 || true
    if docker info >/dev/null 2>&1; then
      err "Rolled back - Docker is up again, with the default ~31-network ceiling."
    else
      err "Docker is STILL down. Inspect: journalctl -u docker -n 50"
    fi
  fi
}

if [ "$STORAGE_ONLY" = "1" ]; then
  skip "Storage-only server: skipping Docker address pools"
elif [ "$IMPORT_ONLY" = "1" ]; then
  # The one step that would MODIFY the host: it writes /etc/docker/daemon.json and
  # restarts the daemon when nothing is running. Deplo deploys nothing here, so
  # the ceiling this raises is irrelevant - and the change is one the uninstall
  # could never take back.
  skip "Migration source: leaving this host's Docker configuration alone"
else
  configure_docker_address_pools
fi

# ==============================================================================
# 2. Agent binary (checksum-verified before it ever runs, P2)
# ==============================================================================
phase "Agent"

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
  note "Pick a host with linux/amd64 or linux/arm64, or wait for a release that includes it."
  exit 1
fi

spin_start "Downloading the Deplo agent v$AGENT_VERSION ($(uname -m))"
TMP="$(mktemp)"
curl -fsSL "$AGENT_BIN_URL" -o "$TMP" </dev/null 2>&9
GOT="$(sha256sum "$TMP" | awk '{print $1}')"
if [ "$GOT" != "$AGENT_SHA256" ]; then
  rm -f "$TMP"
  spin_err "Agent binary checksum mismatch"
  note "Expected $AGENT_SHA256"
  note "Got      $GOT"
  note "Refusing to run an unverified binary."
  exit 1
fi
install -m 0755 "$TMP" "$AGENT_BIN"
rm -f "$TMP"
spin_ok "Agent v$AGENT_VERSION installed" "checksum verified"

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
  step "Existing agent materials found - clearing them for a fresh bootstrap"
  systemctl stop deplo-agent >&9 2>&9 || true
  rm -f "$AGENT_DATA/agent.crt" "$AGENT_DATA/agent.key" "$AGENT_DATA/ca.crt"
  ok "Old materials cleared" "the agent will re-provision with the new token"
fi

# 3a-bis. The platform's `deplo` network -------------------------------------
# NOT where apps go - since ADR-0028 each Environment owns its own network and the
# agent creates that one itself, on both Deploy and Reroute. This is the network
# TRAEFIK sits on, declared `external: true` in the stack written below, so it has
# to exist before the proxy comes up. It used to be created only inside the Traefik
# branch, and a host that already runs a reverse proxy (which is every host anyone
# MIGRATES from) skips that branch and never got one.
if [ "$IMPORT_ONLY" = "1" ]; then
  skip "Migration source: skipping the 'deplo' network (no proxy is installed here)"
else
  docker network create deplo >&9 2>&9 || true
fi

# ==============================================================================
# 3b. Traefik reverse proxy (idempotent)
# ==============================================================================
# Deplo's deploys emit `traefik.*` labels and join their Environment's network, but
# something must READ those labels and route traffic - that is Traefik, which the
# agent connects to each of those networks as it creates them. The master
# host runs it; a remote needs its own. Install it here, but never fight for the
# box: skip if a Traefik is already running (idempotent re-runs, or the operator's
# own proxy), and only claim :80/:443 if they are free, otherwise warn and let
# the operator wire their existing proxy to the `deplo` network.
phase "Reverse proxy"

TRAEFIK_DIR="$AGENT_DATA/traefik"
if [ "$STORAGE_ONLY" = "1" ]; then
  skip "Storage-only server: skipping Traefik (nothing is routed here)"
elif [ "$BUILD_ONLY" = "1" ]; then
  skip "Build-only server: skipping Traefik (it builds images, it routes nothing)"
elif [ "$IMPORT_ONLY" = "1" ]; then
  skip "Migration source: skipping Traefik (this host has its own, and it is not ours)"
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
    warn "Ports 80/443 are already in use on this host, NOT installing Traefik."
    note "Apps deployed here are not routed until a reverse proxy on the shared 'deplo'"
    note "network handles their traefik.* labels. Point your existing proxy at that"
    note "network, or free 80/443 and re-run."
  else
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
    spin_start "Installing Traefik reverse proxy"
    if docker compose -f "$TRAEFIK_DIR/docker-compose.yml" up -d >&9 2>&9 </dev/null \
       || docker-compose -f "$TRAEFIK_DIR/docker-compose.yml" up -d >&9 2>&9 </dev/null; then
      spin_ok "Traefik running" "deplo-traefik, ports 80/443"
    else
      spin_warn "Traefik failed to start"
      note "Apps deployed here will not be routed until it is. Inspect:"
      note "docker compose -f $TRAEFIK_DIR/docker-compose.yml logs"
    fi
  fi
fi

# ==============================================================================
# 4. systemd unit
# ==============================================================================
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
phase "Service"

# mkdir here and not only in the Traefik block above: that one is skipped on a
# storage-only host, and the agent itself does not create --agent-dir until it
# runs. Restrict the file BEFORE the token is written into it, so there is no
# window where it exists world-readable.
BOOTSTRAP_ENV="$AGENT_DATA/bootstrap.env"
mkdir -p "$AGENT_DATA"
chmod 700 "$AGENT_DATA"
trace_off                        # the token again, on its way to disk
: > "$BOOTSTRAP_ENV"
chmod 600 "$BOOTSTRAP_ENV"
cat > "$BOOTSTRAP_ENV" <<EOF
DEPLO_BOOTSTRAP_URL=$URL
DEPLO_BOOTSTRAP_TOKEN=$TOKEN
DEPLO_BOOTSTRAP_FINGERPRINT=$FINGERPRINT
EOF
trace_on
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
ok "systemd unit written" "$UNIT"

# The backup store the agent owns. Created here rather than lazily so a
# storage-only box shows the right permissions from the first minute, and so a
# full disk is visible before the first backup rather than during it.
if [ "$IMPORT_ONLY" = "1" ]; then
  skip "Migration source: skipping the backup store (nothing is stored here)"
else
  mkdir -p /data/backups
  chmod 700 /data/backups
  ok "Backup store ready" "/data/backups"
fi

spin_run "Starting the agent" systemctl daemon-reload
systemctl enable --now deplo-agent >&9 2>&9

# Provisioning is the agent's own round trip to the control plane, and its result
# is a signed certificate on disk. Waiting for that file turns "watch the
# dashboard and hope" into an answer this script can give before it exits.
PROVISIONED=false
spin_start "Waiting for the agent to provision itself against $URL"
i=0
while [ "$i" -lt 45 ]; do
  if [ -s "$AGENT_DATA/agent.crt" ]; then PROVISIONED=true; break; fi
  systemctl is-active --quiet deplo-agent || break
  i=$((i + 1)); sleep 2
done
if [ "$PROVISIONED" = true ]; then
  spin_ok "Agent provisioned" "certificate signed by $URL"
else
  spin_warn "The agent has not provisioned yet"
fi

# ==============================================================================
# 5. Summary
# ==============================================================================
AGENT_STATE="starting"
systemctl is-active --quiet deplo-agent && AGENT_STATE="running"

card_open "This host is a Deplo $HOST_ROLE"
card_kv "Agent" "v$AGENT_VERSION, $AGENT_STATE on port $AGENT_PORT"
card_kv "Panel" "$URL"
card_kv "State" "$AGENT_DATA"
card_kv "Logs" "journalctl -u deplo-agent -f"
card_close

if [ "$AGENT_STATE" != running ]; then
  err "The agent service is not running."
  note "Inspect: journalctl -u deplo-agent -n 50"
elif [ -n "$FIREWALL_FIX" ]; then
  warn "TCP $AGENT_PORT is closed, so Deplo cannot dial this agent."
  note "Provisioning finishes either way, but the server stays offline until you run:"
  note "$FIREWALL_FIX"
elif [ "$PROVISIONED" = true ]; then
  ok "This server is online in the dashboard."
else
  note "The agent is still calling home to $URL. Watch the dashboard - it will"
  note "switch to 'online' shortly, or say why in journalctl -u deplo-agent."
fi
printf '\n'
