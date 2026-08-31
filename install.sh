#!/usr/bin/env bash
#
# Deplo installer / updater
#
#   curl -fsSL https://raw.githubusercontent.com/DeploCloud/deplo/main/install.sh | bash
#
# The dashboard ALWAYS answers on the server's IP at port 3000
# (http://<ip>:3000) - that address is the way back in when a domain, a
# certificate or the proxy is what broke. Pass a real domain to route it through
# Traefik with automatic Let's Encrypt HTTPS as well:
#   curl -fsSL .../install.sh | DEPLO_DOMAIN=deplo.example.com ACME_EMAIL=you@example.com bash
#
# Flags (after `bash -s --`, or on a downloaded copy):
#   --check          run the preflight and exit, changing nothing
#   --domain <d>     serve the dashboard on this domain over HTTPS
#   --email <e>      Let's Encrypt contact address (default admin@<domain>)
#   --version <v>    install this Deplo version instead of `latest`
#   --yes            never ask anything, take every default
#   --force          continue even if the preflight failed
#   --plain          ASCII output, no colour, no spinners
#   --no-color       colour off, keep the rest
#   --quiet          only warnings, errors and the summary
#   --log-file <p>   transcript location (default /var/log/deplo-install.log)
#   --help
#
# Re-running on a machine that already has Deplo updates it in place: it takes a
# pre-update dump of the panel's database first, and rolls the image back if the
# new version does not answer. Secrets are never rotated.
set -Eeuo pipefail

DEPLO_DIR="/opt/deplo"
ENV_FILE="$DEPLO_DIR/.env"
STATE_FILE="$DEPLO_DIR/.install-state"
BACKUP_DIR="$DEPLO_DIR/backups"
DEFAULT_ACME_EMAIL="admin@example.com"

# ==== deplo terminal UI ===================================== KEEP IN SYNC ====
# One renderer for install.sh, install-agent.sh and uninstall.sh. It degrades on
# purpose: no TTY, NO_COLOR, TERM=dumb or a non-UTF-8 locale drops to plain ASCII
# carrying the same words, because installer output is what people paste into a
# bug report. Everything printed also lands in $UI_LOG, stripped of escapes.

UI_COLOR=0; UI_UNICODE=0; UI_TTY=0; UI_QUIET=0; UI_DEPTH=256
UI_LOG="${DEPLO_LOG_FILE:-/var/log/deplo-install.log}"
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

usage() {
  ui_title "Deplo Installer"
  printf ' %bUsage%b\n' "$C_B" "$C_OFF"
  printf '   curl -fsSL https://raw.githubusercontent.com/DeploCloud/deplo/main/install.sh | bash\n\n'
  printf ' %bFlags%b\n' "$C_B" "$C_OFF"
  printf '   --check          run the preflight and exit, changing nothing\n'
  printf '   --domain <d>     serve the dashboard on this domain over HTTPS\n'
  printf '   --email <e>      Let'"'"'s Encrypt contact address\n'
  printf '   --version <v>    install this Deplo version instead of latest\n'
  printf '   --yes            never ask anything, take every default\n'
  printf '   --force          continue even if the preflight failed\n'
  printf '   --plain          ASCII output, no colour, no spinners\n'
  printf '   --no-color       colour off, keep the rest\n'
  printf '   --quiet          only warnings, errors and the summary\n'
  printf '   --log-file <p>   transcript location\n'
  printf '   --help\n\n'
  printf ' %bEnvironment%b  DEPLO_DOMAIN, ACME_EMAIL, DEPLO_VERSION,\n' "$C_B" "$C_OFF"
  printf '               DEPLO_SKIP_NET_CHECKS=1 (no outbound probes, no public-IP lookup),\n'
  printf '               DEPLO_TRACE=0 (transcript without the command trace)\n\n'
}

# --- flags --------------------------------------------------------------------
CHECK_ONLY=false
ASSUME_YES=false
FORCE=false
WANT_HELP=false
# Kept verbatim for the sudo re-exec below, which happens after they are consumed.
ORIG_ARGS=("$@")
while [ $# -gt 0 ]; do
  case "$1" in
    --check)     CHECK_ONLY=true ;;
    --yes|-y)    ASSUME_YES=true ;;
    --force)     FORCE=true ;;
    --plain)     UI_FORCE_PLAIN=1 ;;
    --no-color)  UI_FORCE_NOCOLOR=1 ;;
    --quiet|-q)  UI_QUIET=1 ;;
    --domain)    DEPLO_DOMAIN="${2:-}"; shift ;;
    --email)     ACME_EMAIL="${2:-}"; shift ;;
    --version)   DEPLO_VERSION="${2:-}"; shift ;;
    --log-file)  UI_LOG="${2:-}"; shift ;;
    --help|-h)   WANT_HELP=true ;;
    *)
      ui_init
      err "Unknown flag '$1'. Run with --help."
      exit 1
      ;;
  esac
  shift
done

ui_init ${ORIG_ARGS[@]+"${ORIG_ARGS[@]}"}
trap 'ui_cleanup' EXIT
trap 'spin_kill; printf "\n"; exit 130' INT
trap 'on_err $LINENO' ERR

# `--version v0.9.3` and `--version 0.9.3` are the same request; the image tag is
# the one without the prefix.
DEPLO_VERSION="${DEPLO_VERSION:-latest}"
DEPLO_VERSION="${DEPLO_VERSION#v}"

$WANT_HELP && { usage; exit 0; }

# --- small helpers ------------------------------------------------------------

# A routable domain needs a dot and must not be a local/mDNS name.
is_real_domain() {
  case "$1" in
    "" | localhost | *.local | *.localdomain) return 1 ;;
    *.*) return 0 ;;
    *) return 1 ;;
  esac
}

is_private_ip() {
  case "$1" in
    10.*|127.*|169.254.*|192.168.*|100.6[4-9].*|100.[7-9][0-9].*|100.1[0-1][0-9].*|100.12[0-7].*) return 0 ;;
    172.1[6-9].*|172.2[0-9].*|172.3[0-1].*) return 0 ;;
    *) return 1 ;;
  esac
}

detect_ip() {
  local ip=""
  ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}' | head -n1 || true)"
  [ -z "$ip" ] && ip="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
  [ -z "$ip" ] && ip="127.0.0.1"
  printf '%s' "$ip"
}

# The address the WORLD sees, which behind NAT (a home lab, an LXC container, a
# hypervisor bridge) is not the one above - and printing only the private one
# hands people a dashboard URL that answers from nowhere but the box itself.
detect_public_ip() {
  [ "${DEPLO_SKIP_NET_CHECKS:-0}" = 1 ] && return 1
  local u ip
  for u in https://api.ipify.org https://ifconfig.me/ip https://icanhazip.com; do
    ip="$(curl -fsS --max-time 4 "$u" 2>/dev/null </dev/null | tr -d '[:space:]')" || true
    case "$ip" in ""|*[!0-9.]*) continue ;; esac
    printf '%s' "$ip"; return 0
  done
  return 1
}

# ss, then netstat, then "cannot tell" - never a false accusation.
port_in_use() {
  if command -v ss >/dev/null 2>&1; then
    ss -ltnH 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]$1\$" && return 0
    return 1
  elif command -v netstat >/dev/null 2>&1; then
    netstat -ltn 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]$1\$" && return 0
    return 1
  fi
  return 2
}

port_holder() {
  local who=""
  if command -v ss >/dev/null 2>&1; then
    who="$(ss -ltnpH 2>/dev/null | awk -v p="$1" '$4 ~ "[:.]"p"$" {print $NF}' \
      | sed -n 's/.*users:((\"\([^\"]*\)\".*/\1/p' | head -n1 || true)"
  fi
  printf '%s' "$who"
}

resolve_a() {
  local out=""
  if command -v getent >/dev/null 2>&1; then
    out="$(getent ahostsv4 "$1" 2>/dev/null | awk '{print $1}' | sort -u || true)"
  elif command -v dig >/dev/null 2>&1; then
    out="$(dig +short A "$1" 2>/dev/null | grep -E '^[0-9.]+$' || true)"
  elif command -v host >/dev/null 2>&1; then
    out="$(host -t A "$1" 2>/dev/null | awk '/has address/ {print $NF}' || true)"
  fi
  printf '%s' "$out"
}

# Reachable means "an HTTP response came back", NOT "the status was a success".
# `curl -f` fails on any status >= 400, and https://ghcr.io/v2/ answers 401 to an
# anonymous caller by design (it is the registry ping), so -f reported every host
# on earth as having no egress. %{http_code} is 000 only when nothing answered at
# all - no DNS, no TCP, no TLS, or a timeout - which is the actual question.
# `latest` is a Docker tag, not a version, and a header that reads "latest" tells
# nobody anything. Ask GitHub which release that currently is. The release is
# published AFTER the image is pushed (see docker-image.yml), so a tag that
# answers here has an image behind it - which also makes it safe to PIN, and a
# pinned tag is what gives an update something to roll back TO.
resolve_version() {
  local tag
  [ "${DEPLO_SKIP_NET_CHECKS:-0}" = 1 ] && return 0
  tag="$(curl -fsS --max-time 3 https://api.github.com/repos/DeploCloud/deplo/releases/latest \
    </dev/null 2>&9 \
    | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1 || true)"
  # The git tag carries a `v`, the image tag does not.
  case "$tag" in v[0-9]* | [0-9]*) DEPLO_VERSION="${tag#v}" ;; esac
  return 0
}

can_reach() {
  local code
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 6 "$1" </dev/null 2>&9 || true)"
  ui_log "  reach $1 -> ${code:-none}"
  case "${code:-000}" in "" | 000) return 1 ;; *) return 0 ;; esac
}

state_set() {
  [ -d "$DEPLO_DIR" ] || return 0
  umask 077
  local tmp; tmp="$(mktemp)"
  { [ -f "$STATE_FILE" ] && grep -v "^$1=" "$STATE_FILE"; printf '%s=%s\n' "$1" "$2"; } >"$tmp" 2>/dev/null || true
  install -m 0600 "$tmp" "$STATE_FILE" 2>/dev/null || true
  rm -f "$tmp"
}
state_get() { [ -f "$STATE_FILE" ] || return 0; sed -n "s/^$1=//p" "$STATE_FILE" | tail -n1; }

# One question, on the terminal, never on the script's own stdin: this file may
# be arriving there over a pipe, and taking it away would truncate the install.
ask() {
  local prompt="$1" reply=""
  { [ "$ASSUME_YES" = true ] || [ "$CHECK_ONLY" = true ] || [ "$UI_QUIET" = 1 ] \
    || [ "$UI_TTY" != 1 ] || [ ! -r /dev/tty ]; } && return 1
  printf '  %b%s%b %s ' "$C_ACC" "$G_ARROW" "$C_OFF" "$prompt" >&2
  read -r reply </dev/tty || true
  printf '\n' >&2
  [ -n "$reply" ] || return 1
  printf '%s' "$reply"
}

# --- privileges ---------------------------------------------------------------
if [ "$(id -u)" -ne 0 ]; then
  # Only a script that exists as a FILE can be re-executed. Piped from curl there
  # is nothing to hand sudo, so that case falls through to the message below.
  if command -v sudo >/dev/null 2>&1 && [ -f "${BASH_SOURCE[0]}" ]; then
    step "Not running as root - re-running through sudo"
    exec sudo -E bash "${BASH_SOURCE[0]}" ${ORIG_ARGS[@]+"${ORIG_ARGS[@]}"}
  fi
  ui_title "Deplo Installer"
  err "Deplo installs system services, so this has to run as root."
  note "Re-run it with sudo:"
  note "  curl -fsSL https://raw.githubusercontent.com/DeploCloud/deplo/main/install.sh | sudo bash"
  exit 1
fi

MODE="install"
[ -f "$ENV_FILE" ] && MODE="update"

[ "$DEPLO_VERSION" = latest ] && resolve_version
DEPLO_IMAGE="ghcr.io/deplocloud/deplo:${DEPLO_VERSION}"
case "$DEPLO_VERSION" in latest) VERSION_LABEL="latest" ;; *) VERSION_LABEL="v$DEPLO_VERSION" ;; esac

if [ "$CHECK_ONLY" = true ]; then
  ui_title "Deplo Preflight - $VERSION_LABEL" \
    "Checks whether this machine can run Deplo. Nothing here is changed."
elif [ "$MODE" = update ]; then
  ui_title "Deplo Updater - $VERSION_LABEL" \
    "Updates Deplo in place, in about a minute. Your apps keep running."
else
  ui_title "Deplo Installer - $VERSION_LABEL" \
    "Installs Deplo on this machine - Docker, HTTPS and the dashboard. Nothing to configure."
fi

# ==============================================================================
# 0. Preflight
# ==============================================================================
# Everything that can be known BEFORE the machine is touched is checked here, so
# a host that cannot finish says so in ten seconds instead of after installing
# Docker. Failures stop the run (--force overrides); warnings never do.
phase "Preflight"

PF_FAIL=0
PF_WARN=0
pf_fail() { PF_FAIL=$((PF_FAIL + 1)); err "$1"; [ -n "${2:-}" ] && note "$2"; return 0; }
pf_warn() { PF_WARN=$((PF_WARN + 1)); warn "$1"; [ -n "${2:-}" ] && note "$2"; return 0; }

# System -----------------------------------------------------------------------
OS_NAME="$( . /etc/os-release 2>/dev/null && printf '%s %s' "${NAME:-Linux}" "${VERSION_ID:-}" || true )"
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64|aarch64|arm64) ok "${OS_NAME:-Linux} on $ARCH" ;;
  *) pf_fail "Unsupported architecture '$ARCH'." "Deplo ships linux/amd64 and linux/arm64 images only." ;;
esac

if [ "${BASH_VERSINFO:-0}" -lt 4 ]; then
  pf_fail "Bash 4 or newer is required (found ${BASH_VERSION:-unknown})."
fi

if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  ok "systemd present"
else
  pf_warn "No systemd on this host." "The control plane still runs, but this machine cannot become a Deplo server."
fi

MISSING=""
for bin in curl openssl; do
  command -v "$bin" >/dev/null 2>&1 || MISSING="$MISSING $bin"
done
if [ -n "$MISSING" ]; then
  pf_fail "Missing required tool(s):$MISSING." "Install them with this system's package manager and re-run."
else
  ok "curl and openssl present"
fi

# Resources --------------------------------------------------------------------
MEM_MB="$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 0)"
if [ "${MEM_MB:-0}" -ge 1800 ]; then ok "Memory: ${MEM_MB} MB"
elif [ "${MEM_MB:-0}" -ge 900 ]; then pf_warn "Only ${MEM_MB} MB of RAM." "Deplo and Postgres fit, but builds will be tight. 2 GB is the comfortable floor."
else pf_warn "Only ${MEM_MB} MB of RAM detected." "2 GB is the recommended minimum."; fi

DISK_GB="$(df -PBG / 2>/dev/null | awk 'NR==2 {gsub("G","",$4); print $4}' || true)"
if [ "${DISK_GB:-0}" -ge 20 ]; then ok "Disk: ${DISK_GB} GB free on /"
elif [ "${DISK_GB:-0}" -ge 8 ]; then pf_warn "${DISK_GB} GB free on /." "Images and build caches grow fast; 20 GB is the comfortable floor."
else pf_fail "Only ${DISK_GB:-0} GB free on /." "Docker images alone need more than this. Free some space and re-run."; fi

# Docker -----------------------------------------------------------------------
if command -v docker >/dev/null 2>&1; then
  DOCKER_V="$(docker --version 2>/dev/null | awk '{print $3}' | tr -d , || true)"
  if docker info >/dev/null 2>&1; then ok "Docker $DOCKER_V, daemon responding"
  else pf_fail "Docker $DOCKER_V is installed but its daemon is not answering." "Start it: systemctl start docker"; fi
  if docker compose version >/dev/null 2>&1; then
    ok "Docker Compose $(docker compose version --short 2>/dev/null)"
  else
    pf_fail "Docker Compose v2 (\`docker compose\`) is missing." "Update Docker - it bundles the compose plugin."
  fi
else
  step "Docker is not installed - the installer will add it"
fi

# Ports ------------------------------------------------------------------------
# 80/443 belong to Traefik and 3000 to the panel. Somebody else's nginx on :80 is
# the single most common way an install ends up half-working.
ours_holds_port() {
  docker ps --format '{{.Names}} {{.Ports}}' 2>/dev/null \
    | grep -E '^(deplo-traefik|deplo-deplo-1) ' | grep -q ":$1->"
}
for p in 80 443 3000; do
  PORT_STATE=0
  port_in_use "$p" || PORT_STATE=$?
  case "$PORT_STATE" in
    2) pf_warn "Cannot tell whether the ports are free (no ss or netstat on this host)."; break ;;
    1) ok "Port $p free" ;;
    0)
      if ours_holds_port "$p"; then
        ok "Port $p held by Deplo itself"
      else
        HOLDER="$(port_holder "$p")"
        pf_fail "Port $p is already in use${HOLDER:+ by $HOLDER}." \
          "Deplo needs 80 and 443 for Traefik and 3000 for the dashboard. Free it and re-run."
      fi
      ;;
  esac
done

# Reachability -----------------------------------------------------------------
if [ "${DEPLO_SKIP_NET_CHECKS:-0}" = 1 ]; then
  skip "Network checks skipped (DEPLO_SKIP_NET_CHECKS=1)"
else
  spin_start "Checking outbound connectivity"
  NET_BAD=""
  can_reach "https://ghcr.io/v2/" || NET_BAD="$NET_BAD ghcr.io"
  command -v docker >/dev/null 2>&1 || can_reach "https://get.docker.com" || NET_BAD="$NET_BAD get.docker.com"
  spin_kill
  if [ -n "$NET_BAD" ]; then
    pf_fail "Cannot reach:$NET_BAD." "Deplo pulls its image from ghcr.io. Check egress, a proxy, or a firewall."
  else
    ok "Outbound HTTPS reaches ghcr.io"
  fi
fi

SERVER_IP="$(detect_ip)"
PUBLIC_IP=""
if [ "${DEPLO_SKIP_NET_CHECKS:-0}" != 1 ]; then
  PUBLIC_IP="$(detect_public_ip || true)"
fi
if [ -n "$PUBLIC_IP" ] && [ "$PUBLIC_IP" != "$SERVER_IP" ]; then
  ok "Address: $SERVER_IP on this network, $PUBLIC_IP from the internet"
  is_private_ip "$SERVER_IP" && note "This host is behind NAT - forward 80, 443 and 3000 to $SERVER_IP."
else
  ok "Address: $SERVER_IP"
fi

# The domain, before Let's Encrypt is asked for anything -------------------------
# A certificate ordered for a name that does not point here fails the HTTP-01
# challenge and eats a rate limit that lasts an hour. Resolve it first.
if [ "$MODE" = update ] && [ -z "${DEPLO_DOMAIN:-}" ] && [ -f "$ENV_FILE" ]; then
  DEPLO_DOMAIN="$(grep '^DEPLO_DOMAIN=' "$ENV_FILE" | cut -d= -f2- || true)"
fi

if [ "$MODE" = install ] && [ -z "${DEPLO_DOMAIN:-}" ]; then
  ANSWER="$(ask "Domain for the dashboard (Enter to use http://$SERVER_IP:3000):" || true)"
  [ -n "$ANSWER" ] && DEPLO_DOMAIN="$ANSWER"
fi

if is_real_domain "${DEPLO_DOMAIN:-}"; then
  DOMAIN_IPS="$(resolve_a "$DEPLO_DOMAIN" | tr '\n' ' ' | sed 's/ *$//' || true)"
  TARGET_IP="${PUBLIC_IP:-$SERVER_IP}"
  if [ -z "$DOMAIN_IPS" ]; then
    pf_warn "$DEPLO_DOMAIN does not resolve yet." \
      "Point its A record at $TARGET_IP. The panel still answers on http://$SERVER_IP:3000 meanwhile."
  elif printf '%s' " $DOMAIN_IPS " | grep -q " $TARGET_IP "; then
    ok "$DEPLO_DOMAIN $G_ARROW $TARGET_IP"
  else
    pf_warn "$DEPLO_DOMAIN resolves to $DOMAIN_IPS, not $TARGET_IP." \
      "Let's Encrypt will fail the HTTP-01 challenge until the A record points here."
  fi
  [ "${DEPLO_SKIP_NET_CHECKS:-0}" = 1 ] || can_reach "https://acme-v02.api.letsencrypt.org/directory" \
    || pf_warn "Cannot reach Let's Encrypt." "Certificates will not issue until this host has outbound HTTPS to acme-v02.api.letsencrypt.org."
elif [ -n "${DEPLO_DOMAIN:-}" ]; then
  pf_warn "'$DEPLO_DOMAIN' is not a routable domain - the dashboard will stay on http://$SERVER_IP:3000."
  DEPLO_DOMAIN=""
fi

blank
if [ "$PF_FAIL" -gt 0 ]; then
  err "Preflight found $PF_FAIL blocking $(plural "$PF_FAIL" problem) and $PF_WARN $(plural "$PF_WARN" warning)."
  if [ "$CHECK_ONLY" != true ] && [ "$FORCE" != true ]; then
    note "Fix them and re-run, or pass --force to install anyway."
    exit 1
  fi
elif [ "$PF_WARN" -gt 0 ]; then
  warn "Preflight passed with $PF_WARN $(plural "$PF_WARN" warning)."
else
  ok "Preflight passed."
fi

if [ "$CHECK_ONLY" = true ]; then
  blank
  note "Nothing was changed. Re-run without --check to install."
  [ "$PF_FAIL" -gt 0 ] && exit 1
  exit 0
fi

# ==============================================================================
# 1. Docker
# ==============================================================================
phase "Docker"

if ! command -v docker >/dev/null 2>&1; then
  spin_start "Installing Docker"
  if curl -fsSL https://get.docker.com </dev/null 2>&9 | sh >&9 2>&9; then
    systemctl enable --now docker >&9 2>&9 || true
    spin_ok "Docker installed ($(docker --version 2>/dev/null | awk '{print $3}' | tr -d , || true))"
  else
    spin_err "Docker installation failed"
    note "Transcript: $UI_LOG"
    exit 1
  fi
else
  ok "Docker already installed ($(docker --version 2>/dev/null | awk '{print $3}' | tr -d , || true))"
fi

if ! docker compose version >/dev/null 2>&1; then
  err "Docker Compose v2 (\`docker compose\`) is required but was not found."
  note "Update Docker (it bundles the compose plugin) and re-run."
  exit 1
fi

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

ensure_git

# 1b. Docker address pools ---------------------------------------------------
# Docker's default pools allow ~31 networks and Deplo burns one PER APP, so an
# untouched host dies on its 32nd deploy. Must run before any network exists:
# only a full daemon restart loads new pools. KEEP IN SYNC with install-agent.sh.
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

configure_docker_address_pools

# ==============================================================================
# 2. Workspace, secrets and the platform network
# ==============================================================================
phase "Workspace"

step "Preparing $DEPLO_DIR and the 'deplo' network"
mkdir -p "$DEPLO_DIR/traefik" "$DEPLO_DIR/data" "$DEPLO_DIR/acme"
docker network inspect deplo >/dev/null 2>&1 || docker network create deplo >&9 2>&9
touch "$DEPLO_DIR/acme/acme.json"
chmod 600 "$DEPLO_DIR/acme/acme.json"

# Let's Encrypt sends expiry notices here, so admin@<domain> beats a placeholder
# nobody reads. Changeable from the panel afterwards, and never asked for.
if [ -z "${ACME_EMAIL:-}" ] && is_real_domain "${DEPLO_DOMAIN:-}"; then
  ACME_EMAIL="admin@$DEPLO_DOMAIN"
fi

# Generate secrets once; reuse them on subsequent runs (so updates never rotate).
trace_off                        # DEPLO_SECRET and the database password below
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
trace_on

# A domain (or an ACME address) supplied on a re-run is an EDIT, not a no-op: it
# is the documented way to move a panel from :3000 onto HTTPS, and silently
# keeping the old value would make the flag a lie.
env_put() {
  local key="$1" val="$2" tmp
  [ -n "$val" ] || return 0
  grep -q "^$key=$val\$" "$ENV_FILE" 2>/dev/null && return 0
  umask 077; tmp="$(mktemp)"
  { grep -v "^$key=" "$ENV_FILE" || true; printf '%s=%s\n' "$key" "$val"; } >"$tmp"
  install -m 0600 "$tmp" "$ENV_FILE"; rm -f "$tmp"
  ok "$key set to $val"
}
env_put DEPLO_DOMAIN "${DEPLO_DOMAIN:-}"
env_put ACME_EMAIL "${ACME_EMAIL:-}"

# The token that lets THIS machine enroll itself as a server (agent 0). Appended
# rather than written in the block above so an instance installed before host
# enrollment existed gets one by re-running this script - which is also the
# documented repair when the enrollment at the end of this script fails.
# Deplo reads it from its environment and arms a one-time bootstrap on the server
# row; the agent installer below presents the same token to claim it.
trace_off                        # the enrollment token, here and at its one use
if ! grep -q '^DEPLO_HOST_BOOTSTRAP_TOKEN=' "$ENV_FILE"; then
  umask 077
  echo "DEPLO_HOST_BOOTSTRAP_TOKEN=$(openssl rand -base64 32 | tr -d '/+=\n')" >> "$ENV_FILE"
fi
HOST_TOKEN="$(grep '^DEPLO_HOST_BOOTSTRAP_TOKEN=' "$ENV_FILE" | cut -d= -f2- || true)"
trace_on
# This box's own name, for the server card. Read here because Deplo runs in a
# container, where `hostname` answers with a random container id.
HOST_NAME="$(hostname 2>/dev/null || cat /proc/sys/kernel/hostname 2>/dev/null || echo "")"
ok "Workspace ready" "secrets in $ENV_FILE"

# Resolve how the dashboard is exposed.
DEPLO_DOMAIN="$(grep '^DEPLO_DOMAIN=' "$ENV_FILE" | cut -d= -f2- || true)"
ACME_EMAIL="$(grep '^ACME_EMAIL=' "$ENV_FILE" | cut -d= -f2- || true)"

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
  # Traefik reaches the panel over the `deplo` network at the service's own name
  # and the route lives in the file below; the published port above is the panel's
  # IP address, not how the domain is served. `deplo` is the PLATFORM's network -
  # Traefik and the panel, nothing else - since apps moved to one per Environment
  # (ADR-0028).
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

# ==============================================================================
# 3. Traefik (always up; routes deployed apps, and the panel in domain mode)
# ==============================================================================
phase "Reverse proxy"

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
      # for - the panel when its HTTPS is off, and EVERY app domain on the \`none\`
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
  # Its own internal leg: a socket proxy an app could reach would let it enumerate
  # every other team's containers, environment included. Apps are on their own
  # Environment's network now, but Traefik sits on ALL of them and resolves this
  # proxy BY NAME, so whoever answers that name writes the routing table - which is
  # why the name stays reserved (RESERVED_SHARED_NETWORK_NAMES).
  deplo-socket:
    internal: true
YAML
# Blank lines from an empty block above are harmless YAML, but strip them so the
# file an operator opens on the host reads like one somebody wrote.
sed -i '/^$/d' "$DEPLO_DIR/traefik/docker-compose.yml"
TRAEFIK_NOTE="80/443, for deployed apps"
[ "$USE_DOMAIN" = true ] && TRAEFIK_NOTE="80/443, Let's Encrypt for $DEPLO_DOMAIN"
spin_start "Starting Traefik and its socket proxy"
docker compose -f "$DEPLO_DIR/traefik/docker-compose.yml" --env-file "$ENV_FILE" up -d >&9 2>&9 </dev/null
spin_ok "Traefik running" "$TRAEFIK_NOTE"

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

# ==============================================================================
# 4. Postgres + the Deplo control plane
# ==============================================================================
phase "Control plane"

# On an update, the way back. The image tag is what gets rolled back if the new
# version never answers; the dump is what an operator restores by hand if a
# migration is what went wrong - never automatically, because guessing which of
# the two failed is how you lose a database twice.
PREV_IMAGE=""
DUMP_PATH=""
if [ "$MODE" = update ]; then
  PREV_IMAGE="$(state_get image || true)"
  [ -n "$PREV_IMAGE" ] || PREV_IMAGE="$(awk '/^    image: ghcr.io\/deplocloud\/deplo/ {print $2}' "$DEPLO_DIR/docker-compose.yml" 2>/dev/null | head -n1 || true)"
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^deplo-postgres-1$'; then
    mkdir -p "$BACKUP_DIR"; chmod 700 "$BACKUP_DIR"
    DUMP_PATH="$BACKUP_DIR/pre-update-$(date -u '+%Y%m%d-%H%M%S').sql.gz"
    spin_start "Dumping the panel's database before updating"
    if docker exec deplo-postgres-1 pg_dump -U deplo -d deplo 2>&9 | gzip > "$DUMP_PATH"; then
      chmod 600 "$DUMP_PATH"
      spin_ok "Pre-update dump saved" "$(du -h "$DUMP_PATH" 2>/dev/null | awk '{print $1}' || true)"
      # Three is enough to cover "the last update broke it" without turning the
      # panel's own disk into a backup destination.
      ls -1t "$BACKUP_DIR"/pre-update-*.sql.gz 2>/dev/null | tail -n +4 | xargs -r rm -f || true
    else
      rm -f "$DUMP_PATH"; DUMP_PATH=""
      spin_warn "Could not dump the database - continuing without a pre-update copy"
    fi
  fi
fi

# Compose-substituted vars are escaped (\${...}); shell-computed values inline.
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
    # Its own internal leg, the same rule the socket proxy above follows: it holds
    # only these two, so nothing else reaches the database directly. The panel is
    # on this leg and on \`deplo\`, and no tenant is on either, so the name
    # \`postgres\` is no longer answerable by an app - it stays on the reserved
    # list anyway, because a list costs nothing and an assumption does.
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
if ! spin_run "Pulling $DEPLO_IMAGE" docker pull "$DEPLO_IMAGE"; then
  err "Could not pull $DEPLO_IMAGE."
  note "Check the internet connection, and that $VERSION_LABEL is a released version."
  note "Transcript: $UI_LOG"
  exit 1
fi

spin_run "Starting Postgres and the Deplo control plane" \
  docker compose -f "$DEPLO_DIR/docker-compose.yml" --env-file "$ENV_FILE" up -d

# Always over the IP address, never the domain: in domain mode DNS may not point
# here yet and the certificate may not have issued, while :3000 answers from the
# moment the panel is up. The URL is used only to bootstrap; afterwards the panel
# dials the agent, not the other way round.
AGENT_BOOTSTRAP_URL="http://$SERVER_IP:3000"

wait_for_panel() {
  local tries="$1" i=0
  while [ "$i" -lt "$tries" ]; do
    curl -fsS -o /dev/null --max-time 4 "$AGENT_BOOTSTRAP_URL/api/health" </dev/null 2>/dev/null && return 0
    i=$((i + 1)); sleep 2
  done
  return 1
}

spin_start "Waiting for the control plane to answer"
if wait_for_panel 60; then
  spin_ok "Control plane running" "$DEPLO_IMAGE"
  state_set image "$DEPLO_IMAGE"
  state_set version "$DEPLO_VERSION"
  state_set installed_at "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
else
  spin_err "The control plane did not answer on $AGENT_BOOTSTRAP_URL after 2 minutes"
  # An UPDATE has somewhere to go back to. A first install does not, and pretending
  # otherwise would just hide the logs the operator needs.
  if [ "$MODE" = update ] && [ -n "$PREV_IMAGE" ] && [ "$PREV_IMAGE" != "$DEPLO_IMAGE" ]; then
    warn "Rolling back to $PREV_IMAGE"
    sed -i "s|^    image: $DEPLO_IMAGE\$|    image: $PREV_IMAGE|" "$DEPLO_DIR/docker-compose.yml"
    docker compose -f "$DEPLO_DIR/docker-compose.yml" --env-file "$ENV_FILE" up -d >&9 2>&9 || true
    if wait_for_panel 30; then
      ok "Rolled back - the panel is answering on $PREV_IMAGE again"
      note "The failed version's logs: docker compose -f $DEPLO_DIR/docker-compose.yml logs deplo"
      [ -n "$DUMP_PATH" ] && note "Pre-update database dump: $DUMP_PATH"
      exit 1
    fi
    err "The rollback did not come up either."
  fi
  note "Logs: docker compose -f $DEPLO_DIR/docker-compose.yml logs deplo"
  [ -n "$DUMP_PATH" ] && note "Pre-update database dump: $DUMP_PATH"
  note "Transcript: $UI_LOG"
  exit 1
fi

# ==============================================================================
# 5. This host is a server too (agent 0)
# ==============================================================================
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
phase "This host as a server"

enroll_this_host() {
  if [ -x /usr/local/bin/deplo-agent ]; then
    ok "Server agent already installed on this host"
    return 0
  fi
  # No `sudo`: this script already runs as root (checked at the top). `--quiet`
  # because the agent installer renders the same interface, and two of them
  # stacked reads as the script having started over.
  spin_start "Installing the server agent on this host"
  trace_off                      # $HOST_TOKEN is on this command line
  if curl -fsSL "$AGENT_BOOTSTRAP_URL/install-agent.sh" </dev/null \
     | bash -s -- "$HOST_TOKEN" "$AGENT_BOOTSTRAP_URL" --quiet >&9 2>&9; then
    trace_on
    spin_ok "Server agent installed" "this host is now a Deplo server"
    return 0
  fi
  trace_on
  spin_err "The server agent did not install"
  return 1
}

# Warn and carry on. A panel that is up with one server left to finish is a far
# better place to land than no panel at all, and everything needed to retry is on
# the box: re-running this script re-arms the token and installs the agent again.
HOST_ENROLLED=true
if ! enroll_this_host; then
  HOST_ENROLLED=false
  err "This host was not added as a server. Deplo itself is installed and running."
  note "Transcript: $UI_LOG"
  note "Re-run this script to try again, or add the server from Settings > Servers."
fi

# ==============================================================================
# 6. Summary
# ==============================================================================
TOTAL=$(( SECONDS - UI_T0 ))
if [ "$MODE" = update ]; then
  card_open "Deplo updated in ${TOTAL}s"
else
  card_open "Deplo installed in ${TOTAL}s"
fi
card_kv "Dashboard" "$PUBLIC_URL"
[ "$USE_DOMAIN" = true ] && card_kv "Fallback" "http://$SERVER_IP:3000"
card_kv "Version" "$VERSION_LABEL"
card_kv "Data dir" "$DEPLO_DIR"
card_kv "Database" "Postgres, private network only"
if [ "$USE_DOMAIN" = true ]; then
  card_kv "Proxy" "Traefik, ports 80/443, automatic HTTPS"
else
  card_kv "Proxy" "Traefik, ports 80/443, for deployed apps"
fi
[ "$HOST_ENROLLED" = true ] && card_kv "Server" "${HOST_NAME:-$SERVER_IP}, this machine"
card_close

printf ' %bNext%b\n' "$C_B" "$C_OFF"
if [ "$MODE" != update ]; then
  printf '   1  Open %b%s%b and create your account.\n' "$C_ACC" "$PUBLIC_URL" "$C_OFF"
  printf '   2  Connect a repository from Settings > Git.\n'
  printf '   3  Deploy your first app.\n\n'
else
  printf '   Open %b%s%b - your apps kept running throughout.\n\n' "$C_ACC" "$PUBLIC_URL" "$C_OFF"
fi

if [ "$USE_DOMAIN" = true ]; then
  note "Point $DEPLO_DOMAIN at ${PUBLIC_IP:-$SERVER_IP}; the certificate issues on the first request."
else
  note "To serve the dashboard over HTTPS on a domain, re-run with --domain <your domain>."
fi
note "GitHub must be able to reach $PUBLIC_URL for callbacks and webhooks."
[ "$UI_LOG" = /dev/null ] || note "Transcript: $UI_LOG"
printf '\n'
