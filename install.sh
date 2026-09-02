#!/usr/bin/env bash
#
# Deplo installer / updater
#
#   curl -fsSL https://raw.githubusercontent.com/DeploCloud/deplo/main/install.sh | bash
#
# The dashboard is ALWAYS served over HTTPS by Traefik, on a real hostname. Give
# it a domain and it uses that; give it nothing and this script generates
# deplo-<hex>.nip.io, which resolves to this server with no DNS to set up. Port
# 3000 is published on 127.0.0.1 only, so the way back in when the proxy itself is
# what broke is an SSH tunnel, never the open internet.
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
#
# On a machine that already runs Dokploy or Coolify the install is a TAKEOVER, or
# it is nothing: two panels cannot share 80 and 443. Deplo installs on temporary
# ports, the migration happens in the browser, and this window takes the ports
# when the operator says so. Set DEPLO_TAKEOVER=dokploy|coolify to consent without
# being asked; --yes deliberately does not.
set -Eeuo pipefail

DEPLO_DIR="/opt/deplo"
ENV_FILE="$DEPLO_DIR/.env"
STATE_FILE="$DEPLO_DIR/.install-state"
INSTALLER_URL="https://raw.githubusercontent.com/DeploCloud/deplo/main/install.sh"
BACKUP_DIR="$DEPLO_DIR/backups"

# ==== Deplo terminal UI ===================================== KEEP IN SYNC ====
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
  printf '               DEPLO_TRACE=0 (transcript without the command trace),\n'
  printf '               DEPLO_IMAGE=<ref> (an image already on the host, no pull),\n'
  printf '               DEPLO_TAKEOVER=dokploy|coolify (replace that panel without being asked),\n'
  printf '               DEPLO_TAKEOVER_WAIT=<seconds> (how long this window waits, default 7200)\n\n'
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

# The 8-char hex of an IPv4, the label nip.io routes on: 1.2.3.4 -> 01020304.
# KEEP IN SYNC with `ipToHex` in lib/deploy/domains.ts.
ip_hex() {
  local IFS=.
  case "$1" in "" | *[!0-9.]*) return 1 ;; esac
  # shellcheck disable=SC2086
  set -- $1
  [ $# -eq 4 ] || return 1
  # `10#0$n` so a zero-padded or empty octet is not read as octal, which under
  # `set -e` would end the install on an arithmetic error.
  printf '%02x%02x%02x%02x' "$((10#0$1))" "$((10#0$2))" "$((10#0$3))" "$((10#0$4))"
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

# --- the platform already on this machine --------------------------------------
# Deplo cannot share ports 80 and 443 with another panel, so on a machine that has
# one the install is a TAKEOVER or it is nothing. Only these two are migratable;
# anything else holding the ports is still a hard stop.
# A RUNNING control-plane container is the evidence, never a directory: a box that
# once had Dokploy keeps /etc/dokploy forever, and one measured here was reported
# as a Dokploy machine while Coolify was the thing actually holding the ports.
# Dokploy runs its panel as a swarm task (`dokploy.1.<id>`), hence the anchors.
detect_foreign_platform() {
  local names
  names="$(docker ps --format '{{.Names}}' 2>/dev/null || true)"
  if printf '%s\n' "$names" | grep -qE '^dokploy(-traefik$|-postgres\.|\.)'; then
    printf 'dokploy'; return 0
  fi
  if printf '%s\n' "$names" | grep -qE '^coolify(-proxy|-db|-realtime)?$'; then
    printf 'coolify'; return 0
  fi
  printf ''
}

platform_label() {
  case "$1" in dokploy) printf 'Dokploy' ;; coolify) printf 'Coolify' ;; *) printf '%s' "$1" ;; esac
}

# Where its own dashboard answers, which is what the migration wizard reads.
platform_panel_port() {
  case "$1" in coolify) printf '8000' ;; *) printf '3000' ;; esac
}

# Its Traefik's certificate store, inherited at the cutover so the domains that
# already point here keep answering HTTPS without asking Let's Encrypt again.
platform_acme_file() {
  case "$1" in
    dokploy) printf '/etc/dokploy/traefik/dynamic/acme.json' ;;
    coolify) printf '/data/coolify/proxy/acme.json' ;;
    *) printf '' ;;
  esac
}

# The first of these that nothing is listening on. Empty when they are all taken.
first_free_port() {
  local p
  for p in "$@"; do
    port_in_use "$p" || { printf '%s' "$p"; return 0; }
  done
  printf ''
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
  if command -v sudo >/dev/null 2>&1 && [ -f "${BASH_SOURCE[0]:-}" ]; then
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

# An image already on the host, for an air-gapped install or a registry mirror.
# Set it and the version lookup and the pull below are both skipped.
IMAGE_PINNED=false
if [ -n "${DEPLO_IMAGE:-}" ]; then
  IMAGE_PINNED=true
  VERSION_LABEL="$DEPLO_IMAGE"
else
  [ "$DEPLO_VERSION" = latest ] && resolve_version
  DEPLO_IMAGE="ghcr.io/deplocloud/deplo:${DEPLO_VERSION}"
  case "$DEPLO_VERSION" in latest) VERSION_LABEL="latest" ;; *) VERSION_LABEL="v$DEPLO_VERSION" ;; esac
fi

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
# 80/443 belong to Traefik, and 3000 to the panel on loopback - a bind that still
# collides with anything else holding that port. Somebody else's nginx on :80 is
# the single most common way an install ends up half-working.
ours_holds_port() {
  docker ps --format '{{.Names}} {{.Ports}}' 2>/dev/null \
    | grep -E '^(deplo-traefik|deplo-deplo-1) ' | grep -q ":$1->"
}

# A takeover already in flight keeps the ports it chose; a fresh one asks first.
# Past the cutover the ports are already Deplo's and nothing below moves them,
# but the other platform is still on the disk and removing it is a re-run away.
TAKEOVER=""
TAKEOVER_PAST=0
TAKEOVER_STATE="$(state_get takeover || true)"
case "$TAKEOVER_STATE" in
  pending | ready) TAKEOVER="$(state_get takeover_platform || true)" ;;
  done | removing)
    TAKEOVER="$(state_get takeover_platform || true)"
    TAKEOVER_PAST=1
    ;;
esac

if [ -z "$TAKEOVER" ] && [ "$MODE" = install ]; then
  FOREIGN="$(detect_foreign_platform)"
  if [ -n "$FOREIGN" ]; then
    FOREIGN_LABEL="$(platform_label "$FOREIGN")"
    blank
    warn "$FOREIGN_LABEL is already running on this machine."
    note "Deplo can only install here by taking its place: it brings your projects"
    note "across, then removes $FOREIGN_LABEL. Two panels cannot share 80 and 443."
    note "Nothing is touched until you have looked at what came over."
    if [ "$CHECK_ONLY" = true ]; then
      # Report on the install that WOULD happen, temporary ports and all -
      # nothing here changes anything, and a check that measured the wrong ports
      # would fail the machine over a conflict the real install never has.
      TAKEOVER="$FOREIGN"
      pf_warn "This install would be a takeover of $FOREIGN_LABEL." \
        "Deplo would wait on a free port until you finished the migration."
    elif [ "${DEPLO_TAKEOVER:-}" = "$FOREIGN" ]; then
      TAKEOVER="$FOREIGN"
      ok "Taking over from $FOREIGN_LABEL (DEPLO_TAKEOVER=$FOREIGN)"
    else
      # --yes deliberately does NOT answer this one: removing somebody else's
      # platform is not a default to take on their behalf.
      ANSWER="$(ask "Migrate off $FOREIGN_LABEL and let Deplo replace it? [y/N]" || true)"
      case "$ANSWER" in
        y | Y | yes | YES | s | S | si | SI)
          TAKEOVER="$FOREIGN"
          ;;
        *)
          blank
          err "Nothing was installed - $FOREIGN_LABEL is still yours."
          note "To take it over later, re-run this and answer yes, or set"
          note "  DEPLO_TAKEOVER=$FOREIGN"
          exit 1
          ;;
      esac
    fi
  fi
fi

# Where the panel and the proxy answer. Everything downstream reads these, so the
# cutover is this script run again with the real ones.
PANEL_PORT=3000
HTTP_PORT=80
HTTPS_PORT=443
PROXY_BIND=""

# A port this install already chose, when it is still free or already ours - so a
# re-run does not walk the panel down the list every time it is called.
kept_port() {
  local kept; kept="$(state_get "$1" || true)"
  [ -n "$kept" ] || return 1
  ours_holds_port "$kept" && { printf '%s' "$kept"; return 0; }
  port_in_use "$kept" && return 1
  printf '%s' "$kept"
}

if [ -n "$TAKEOVER" ] && [ "$TAKEOVER_PAST" = 0 ]; then
  # The other panel keeps what it has; Deplo waits its turn somewhere free, on
  # LOOPBACK: an account-creation page on a certificate Deplo signed itself has
  # no business on the open internet, and a published port bypasses ufw.
  PROXY_BIND="127.0.0.1:"
  PANEL_PORT="$(kept_port takeover_panel_port || first_free_port 3000 3001 3002 3003)"
  HTTP_PORT="$(kept_port takeover_http_port || first_free_port 8080 8081 8090)"
  HTTPS_PORT="$(kept_port takeover_https_port || first_free_port 8443 8444 9443)"
  if [ -z "$PANEL_PORT" ] || [ -z "$HTTP_PORT" ] || [ -z "$HTTPS_PORT" ]; then
    pf_fail "No free port left for Deplo to wait on." \
      "Free one of 3000-3003, 8080-8090 or 8443-9443 and re-run."
    PANEL_PORT="${PANEL_PORT:-3001}"; HTTP_PORT="${HTTP_PORT:-8080}"; HTTPS_PORT="${HTTPS_PORT:-8443}"
  fi
  ok "Deplo waits on :$PANEL_PORT until the takeover" "proxy on $HTTP_PORT/$HTTPS_PORT"
fi

for p in $HTTP_PORT $HTTPS_PORT $PANEL_PORT; do
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
          "Deplo needs $HTTP_PORT and $HTTPS_PORT for Traefik and $PANEL_PORT for the dashboard. Free it and re-run."
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
TARGET_IP="${PUBLIC_IP:-$SERVER_IP}"
if [ -n "$PUBLIC_IP" ] && [ "$PUBLIC_IP" != "$SERVER_IP" ]; then
  ok "Address: $SERVER_IP on this network, $PUBLIC_IP from the internet"
  is_private_ip "$SERVER_IP" && note "This host is behind NAT - forward $HTTP_PORT and $HTTPS_PORT to $SERVER_IP."
else
  ok "Address: $SERVER_IP"
fi

# The dashboard's own address when nobody gives it a domain. nip.io is public
# wildcard DNS: a host whose last label before .nip.io is an IPv4 in hex resolves
# to that IP, with nothing to set up. Same shape lib/deploy/domains.ts mints for
# apps, so the panel and the apps on it read alike.
FALLBACK_HOST="deplo-$(ip_hex "$TARGET_IP" || ip_hex 127.0.0.1).nip.io"

# The domain, before Let's Encrypt is asked for anything -------------------------
# A certificate ordered for a name that does not point here fails the HTTP-01
# challenge and eats a rate limit that lasts an hour. Resolve it first.
if [ "$MODE" = update ] && [ -z "${DEPLO_DOMAIN:-}" ] && [ -f "$ENV_FILE" ]; then
  DEPLO_DOMAIN="$(grep '^DEPLO_DOMAIN=' "$ENV_FILE" | cut -d= -f2- || true)"
fi

if [ "$MODE" = install ] && [ -z "${DEPLO_DOMAIN:-}" ]; then
  ANSWER="$(ask "Domain for the dashboard (Enter for https://$FALLBACK_HOST):" || true)"
  [ -n "$ANSWER" ] && DEPLO_DOMAIN="$ANSWER"
fi

# A bare address reads as a domain to the lexical check below, and no certificate
# authority issues for one. The generated host is the better answer.
if [ -n "${DEPLO_DOMAIN:-}" ] && ip_hex "${DEPLO_DOMAIN}" >/dev/null 2>&1; then
  pf_warn "'$DEPLO_DOMAIN' is an IP address, not a domain, so the dashboard stays on https://$FALLBACK_HOST."
  DEPLO_DOMAIN=""
fi

if is_real_domain "${DEPLO_DOMAIN:-}"; then
  DOMAIN_IPS="$(resolve_a "$DEPLO_DOMAIN" | tr '\n' ' ' | sed 's/ *$//' || true)"
  if [ -z "$DOMAIN_IPS" ]; then
    pf_warn "$DEPLO_DOMAIN does not resolve yet." \
      "Point its A record at $TARGET_IP. The dashboard answers on https://$FALLBACK_HOST meanwhile."
  elif printf '%s' " $DOMAIN_IPS " | grep -q " $TARGET_IP "; then
    ok "$DEPLO_DOMAIN $G_ARROW $TARGET_IP"
  else
    pf_warn "$DEPLO_DOMAIN resolves to $DOMAIN_IPS, not $TARGET_IP." \
      "Let's Encrypt will fail the HTTP-01 challenge until the A record points here."
  fi
else
  if [ -n "${DEPLO_DOMAIN:-}" ]; then
    pf_warn "'$DEPLO_DOMAIN' is not a routable domain, so the dashboard stays on https://$FALLBACK_HOST."
    DEPLO_DOMAIN=""
  fi
  # The generated host is only an address if this network resolves it. Some
  # resolvers drop answers pointing into a private range (DNS rebind protection),
  # which is exactly what a nip.io host for a LAN address is.
  if [ "${DEPLO_SKIP_NET_CHECKS:-0}" != 1 ]; then
    case " $(resolve_a "$FALLBACK_HOST" | tr '\n' ' ') " in
      *" $TARGET_IP "*) ok "$FALLBACK_HOST $G_ARROW $TARGET_IP" ;;
      *) pf_warn "$FALLBACK_HOST does not resolve from this host." \
           "nip.io needs public DNS. If this network blocks it, re-run with --domain <your domain>." ;;
    esac
  fi
fi

# Out of the branch: the panel is served over HTTPS either way now, so a
# certificate is ordered either way.
[ "${DEPLO_SKIP_NET_CHECKS:-0}" = 1 ] || can_reach "https://acme-v02.api.letsencrypt.org/directory" \
  || pf_warn "Cannot reach Let's Encrypt." "Certificates will not issue until this host has outbound HTTPS to acme-v02.api.letsencrypt.org."

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

# Let's Encrypt sends expiry notices here, so admin@<the panel's own host> beats
# a placeholder nobody reads - and beats admin@example.com, which Let's Encrypt
# refuses as a contact, taking ACME registration and every certificate on this
# host with it. Changeable from the panel afterwards, and never asked for.
if [ -z "${ACME_EMAIL:-}" ]; then
  if is_real_domain "${DEPLO_DOMAIN:-}"; then
    ACME_EMAIL="admin@$DEPLO_DOMAIN"
  else
    ACME_EMAIL="admin@$FALLBACK_HOST"
  fi
fi

# Generate secrets once; reuse them on subsequent runs (so updates never rotate).
trace_off                        # DEPLO_SECRET and the database password below
if [ ! -f "$ENV_FILE" ]; then
  umask 077
  {
    echo "DEPLO_VERSION=$DEPLO_VERSION"
    echo "DEPLO_DOMAIN=${DEPLO_DOMAIN:-}"
    echo "ACME_EMAIL=$ACME_EMAIL"
    echo "DEPLO_SECRET=$(openssl rand -base64 48 | tr -d '\n')"
    echo "DEPLO_DB_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=\n')"
  } > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
fi
trace_on

# A domain (or an ACME address) supplied on a re-run is an EDIT, not a no-op: it
# is the documented way to move the panel onto a domain you own, and silently
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

# The takeover, now that there is a directory to remember it in. The copy of this
# script is what makes every "re-run it" instruction below true, including from a
# terminal that has since been closed.
if [ -n "$TAKEOVER" ]; then
  [ -n "$TAKEOVER_STATE" ] || TAKEOVER_STATE=pending
  state_set takeover "$TAKEOVER_STATE"
  state_set takeover_platform "$TAKEOVER"
  state_set takeover_panel_port "$PANEL_PORT"
  state_set takeover_http_port "$HTTP_PORT"
  state_set takeover_https_port "$HTTPS_PORT"
  if [ -f "${BASH_SOURCE[0]:-}" ]; then
    install -m 0700 "${BASH_SOURCE[0]}" "$DEPLO_DIR/install.sh" 2>/dev/null || true
  elif [ ! -f "$DEPLO_DIR/install.sh" ]; then
    curl -fsSL "$INSTALLER_URL" -o "$DEPLO_DIR/install.sh" 2>&9 \
      && chmod 700 "$DEPLO_DIR/install.sh" || true
  fi
fi

# Resolve how the dashboard is exposed.
DEPLO_DOMAIN="$(grep '^DEPLO_DOMAIN=' "$ENV_FILE" | cut -d= -f2- || true)"
ACME_EMAIL="$(grep '^ACME_EMAIL=' "$ENV_FILE" | cut -d= -f2- || true)"

# The panel publishes :3000 on 127.0.0.1 ONLY. Never on the server's address: an
# open port is a login page on the internet with no TLS in front of it, and every
# password and session cookie it takes crosses the wire in clear. Traefik serves
# the panel over HTTPS on the host below instead, always. Loopback stays because
# two things need it: this installer bootstraps the server agent through it, and
# an SSH tunnel is the way back in when the proxy itself is what broke.
DEPLO_EXPOSE="$(printf '    ports:\n      - "127.0.0.1:%s:3000"' "$PANEL_PORT")"

# The panel's own route is a Traefik FILE-provider config, not labels on this
# container - and that difference is the whole point. A container's compose file
# belongs to this installer and no agent RPC can rewrite it, so a panel published
# by labels can never be changed from the panel: not its address, not whether it
# orders a certificate. A dynamic-config file is something Deplo is already
# allowed to write - it is how custom certificates are installed.
#
# KEEP IN SYNC with `withPanelRoute` in lib/deploy/traefik-stack.ts, which reads
# and rewrites exactly this shape: it replaces the `deplo-panel` router and
# service in place and leaves the rest of the file alone, which is what keeps the
# fallback router below alive across an edit from the panel. `priority: 2` keeps a
# Host-only router a true fallback so any more-specific PathPrefix router on the
# same host (an app's path override, or the reserved /plugins/<slug> route)
# outranks it - Traefik would otherwise default it to its rule-string length and
# shadow them. Traefik reaches the panel over the `deplo` network at the service's
# own name: `deplo` is the PLATFORM's network - Traefik and the panel, nothing
# else - since apps moved to one per Environment (ADR-0028).
if is_real_domain "$DEPLO_DOMAIN"; then
  USE_DOMAIN=true
  PANEL_HOST="$DEPLO_DOMAIN"
else
  USE_DOMAIN=false
  PANEL_HOST="$FALLBACK_HOST"
fi

# Traefik terminates on 443; before a takeover moves the ports it is somewhere
# else, and an address that left the port out would name the panel this one is
# replacing.
panel_url() {
  case "$HTTPS_PORT" in
    443) printf 'https://%s' "$PANEL_HOST" ;;
    *) printf 'https://%s:%s' "$PANEL_HOST" "$HTTPS_PORT" ;;
  esac
}
PUBLIC_URL="$(panel_url)"

# One router per host, both onto the one service. Unquoted scalars on purpose:
# this is byte-for-byte what `withPanelRoute` re-renders, so the first edit from
# the panel produces no spurious diff in the file an operator may be reading on
# the host.
panel_router() { # $1 router name, $2 host
  printf '          %s:\n            rule: Host(`%s`)\n            entryPoints:\n              - websecure\n            service: deplo-panel\n            priority: 2\n            tls:\n              certResolver: letsencrypt\n' "$1" "$2"
}

TRAEFIK_CONFIG_MOUNT="$(printf '    configs:\n      - source: deplo-panel\n        target: /deplo-dynamic/deplo-panel.yml\n        mode: 256')"
TRAEFIK_FILE_PROVIDER="$(printf '      - --providers.file.directory=/deplo-dynamic\n      - --providers.file.watch=true')"
# The generated host stays routed underneath the domain: it is the address that
# still answers when the domain, its DNS or its certificate is what broke, and it
# needs no proxy of its own to do it. Only when the panel IS that host is there
# one router, because two identical rules at one priority is a conflict.
TRAEFIK_PANEL_CONFIG="$(
  printf 'configs:\n  deplo-panel:\n    content: |\n      http:\n        routers:\n'
  panel_router deplo-panel "$PANEL_HOST"
  [ "$PANEL_HOST" = "$FALLBACK_HOST" ] || panel_router deplo-panel-fallback "$FALLBACK_HOST"
  printf '        services:\n          deplo-panel:\n            loadBalancer:\n              servers:\n                - url: http://deplo:3000\n              passHostHeader: true'
)"

# ==============================================================================
# 3. Traefik (always up; routes deployed apps, and the panel in domain mode)
# ==============================================================================
phase "Reverse proxy"

# traefik:v3.7 (NOT v3.3): Docker Engine 29 raised the min API to 1.40, which
# Traefik <=3.3 cannot negotiate, breaking the docker provider on every poll.
# container_name is what the agent identifies OUR proxy by - without it Deplo
# refuses to manage this stack and the panel's own settings go read-only.
# One renderer, called again by the takeover when the real ports come free.
write_traefik_compose() {
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
      - "$PROXY_BIND$HTTP_PORT:80"
      - "$PROXY_BIND$HTTPS_PORT:443"
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
}

write_traefik_compose
TRAEFIK_NOTE="$HTTP_PORT/$HTTPS_PORT, Let's Encrypt for $PANEL_HOST"
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
# Same reason as the proxy's: the takeover re-renders this when the real ports
# come free.
write_panel_compose() {
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
      # Empty on an ordinary install. The panel seeds its takeover state from
      # this once, then owns it - so the cutover clearing it changes nothing.
      - DEPLO_TAKEOVER=$TAKEOVER
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
}

write_panel_compose

# Pull the control-plane image first so a bad version tag (or, on an update, the
# newest image) fails clearly instead of a cryptic compose error. The image is
# public, so let Docker's own message through rather than guessing the cause.
# A pinned image is only ever skipped when it is REALLY here: an update must
# still pull, or `latest` would never move again.
if [ "$IMAGE_PINNED" = true ] && docker image inspect "$DEPLO_IMAGE" >/dev/null 2>&9; then
  skip "$DEPLO_IMAGE is already on this host"
elif ! spin_run "Pulling $DEPLO_IMAGE" docker pull "$DEPLO_IMAGE"; then
  err "Could not pull $DEPLO_IMAGE."
  note "Check the internet connection, and that $VERSION_LABEL is a released version."
  note "Transcript: $UI_LOG"
  exit 1
fi

spin_run "Starting Postgres and the Deplo control plane" \
  docker compose -f "$DEPLO_DIR/docker-compose.yml" --env-file "$ENV_FILE" up -d

# Over loopback, never the domain: DNS may not point here yet and the certificate
# may not have issued, while 127.0.0.1 answers from the moment the panel is up.
# Plain http is fine on it - the bootstrap is HMAC-signed by the token and the
# packet never leaves the host. Used only to bootstrap; afterwards the panel dials
# the agent, not the other way round.
AGENT_BOOTSTRAP_URL="http://127.0.0.1:$PANEL_PORT"

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
# 5b. The takeover: wait for the wizard, then take the ports
# ==============================================================================
#
# The browser does the migration; this window does the part only root on the host
# can do - stopping the other platform, moving the ports, and restarting Docker so
# the address pools written during the install finally apply.

TAKEOVER_API="$AGENT_BOOTSTRAP_URL/api/takeover"

# The panel's own answer, or empty when it cannot be asked.
takeover_get() {
  curl -fsS --max-time 6 -H "Authorization: Bearer $HOST_TOKEN" "$TAKEOVER_API" </dev/null 2>&9 || true
}

takeover_field() {
  printf '%s' "$1" | sed -n "s/.*\"$2\":[[:space:]]*\"\{0,1\}\([^,\"}]*\)\"\{0,1\}.*/\1/p" | head -n1
}

takeover_post() {
  curl -fsS --max-time 20 -X POST -H "Authorization: Bearer $HOST_TOKEN" \
    -H 'Content-Type: application/json' -d "{\"state\":\"$1\"}" "$TAKEOVER_API" >&9 2>&9 || true
}

# A route dropped into the other platform's Traefik, which both watch and reload
# on their own. Additive, and taken away again at the cutover.
takeover_side_door() {
  local dir="" entry="" proxy="" host="deplo-setup.$SERVER_IP.sslip.io"
  # Their entrypoints are NOT called the same thing, and a router pinned to no
  # entrypoint at all binds to :443 too - where Dokploy's would order a
  # certificate for a name nobody is going to visit over https.
  case "$TAKEOVER" in
    dokploy) dir=/etc/dokploy/traefik/dynamic; entry=web; proxy=dokploy-traefik ;;
    coolify) dir=/data/coolify/proxy/dynamic; entry=http; proxy=coolify-proxy ;;
  esac
  if [ -z "$dir" ] || [ ! -d "$dir" ]; then
    printf 'not available - %s has no dynamic config directory here' "$FOREIGN_LABEL"
    return 0
  fi
  # The panel is published on loopback only, which a container cannot reach. Put
  # their proxy on the platform network and let it resolve the panel by name, the
  # same way ours does.
  docker network connect deplo "$proxy" >&9 2>&9 || true
  cat > "$dir/deplo-setup.yml" <<YAML
http:
  routers:
    deplo-setup:
      rule: Host(\`$host\`)
      entryPoints:
        - $entry
      service: deplo-setup
  services:
    deplo-setup:
      loadBalancer:
        servers:
          - url: http://deplo:3000
YAML
  printf 'http://%s' "$host"
}

takeover_side_door_remove() {
  rm -f /etc/dokploy/traefik/dynamic/deplo-setup.yml \
        /data/coolify/proxy/dynamic/deplo-setup.yml 2>/dev/null || true
  docker network disconnect deplo dokploy-traefik >&9 2>&9 || true
  docker network disconnect deplo coolify-proxy >&9 2>&9 || true
}

# Every way into the panel, in the order they cost the operator something.
takeover_unreachable_advice() {
  blank
  warn "Nothing has opened Deplo yet."
  note "Until the ports move its proxy is bound to loopback on purpose, so there is"
  note "no login page of Deplo's on the internet yet. Two ways in:"
  note "  1. Through $FOREIGN_LABEL's own proxy on port 80:"
  note "     $(takeover_side_door)"
  note "  2. From your own machine, over SSH:"
  note "     ssh -L $PANEL_PORT:localhost:$PANEL_PORT root@$SERVER_IP"
  note "     then open http://localhost:$PANEL_PORT"
}

# Everything the other platform put on this machine, by container name.
foreign_containers() {
  docker ps -a --format '{{.Names}}' 2>/dev/null | grep -E "^$TAKEOVER" || true
}

# The platform's own SWARM services, which is how Dokploy runs its panel and its
# database. Stopping the task container is not stopping them: the swarm puts it
# straight back and takes :3000 with it.
foreign_services() {
  [ "$TAKEOVER" = dokploy ] || return 0
  docker service ls --format '{{.Name}}' 2>/dev/null | grep -E '^dokploy(-postgres)?$' || true
}

# Stop it for good: `--restart=no` FIRST, or the docker restart below brings the
# whole platform back up underneath Deplo. Its APPS go down with it - they hold
# the ports Deplo's proxy is about to take, and two copies of one app would run.
foreign_stop() {
  local names svc n c pol saved=""
  for svc in $(foreign_services); do
    n="$(docker service inspect "$svc" --format '{{.Spec.Mode.Replicated.Replicas}}' 2>/dev/null || true)"
    state_set "foreign_replicas_$svc" "${n:-1}"
    # --detach, or this blocks until the service converges - and a panel whose
    # database is already at zero never will.
    docker service update --detach --replicas 0 "$svc" >&9 2>&9 || true
  done
  names="$(printf '%s\n%s\n' "$(foreign_containers)" "$(foreign_workloads)" \
    | grep -v '^$' | sort -u || true)"
  [ -n "$names" ] || return 0
  # What each RUNNING one had, so the rollback restores the policy it found
  # instead of inventing one. A container already down stays down.
  for c in $names; do
    pol="$(docker inspect "$c" --format '{{if .State.Running}}{{or .HostConfig.RestartPolicy.Name "no"}}{{end}}' 2>/dev/null || true)"
    [ -n "$pol" ] && saved="$saved $c:$pol"
  done
  state_set foreign_restart "${saved# }"
  # shellcheck disable=SC2086
  docker update --restart=no $names >&9 2>&9 || true
  # shellcheck disable=SC2086
  docker stop $names >&9 2>&9 || true
}

# The way back: every container foreign_stop took down, on the policy it had.
foreign_start() {
  local svc n pair c pol
  for svc in $(foreign_services); do
    n="$(state_get "foreign_replicas_$svc" || true)"
    docker service update --detach --replicas "${n:-1}" "$svc" >&9 2>&9 || true
  done
  for pair in $(state_get foreign_restart || true); do
    c="${pair%:*}"; pol="${pair##*:}"
    docker update --restart="${pol:-no}" "$c" >&9 2>&9 || true
    docker start "$c" >&9 2>&9 || true
  done
}

# The certificates the domains pointing here already have. Best effort by design:
# Traefik asks Let's Encrypt for anything it does not find, so a store we cannot
# read costs a re-issue, never a broken install.
inherit_acme() {
  local src
  src="$(platform_acme_file "$TAKEOVER")"
  if [ -z "$src" ] || [ ! -s "$src" ]; then
    skip "No certificate store to inherit from $FOREIGN_LABEL"
    return 0
  fi
  local dst="$DEPLO_DIR/acme/acme.json"
  [ -s "$dst" ] && cp "$dst" "$dst.deplo-bak" 2>/dev/null
  # Deplo's resolver is called `letsencrypt`; theirs may not be. One key, renamed,
  # and nothing written unless it really holds certificates.
  if command -v python3 >/dev/null 2>&1 && python3 -c '
import json, sys
src, dst = sys.argv[1], sys.argv[2]
with open(src) as f:
    d = json.load(f)
if not isinstance(d, dict) or not d:
    raise SystemExit(1)
key = "letsencrypt" if "letsencrypt" in d else sorted(d)[0]
body = d[key]
if not isinstance(body, dict) or not body.get("Certificates"):
    raise SystemExit(1)
with open(dst, "w") as f:
    json.dump({"letsencrypt": body}, f)' "$src" "$dst" 2>&9; then
    chmod 600 "$dst"
    ok "Certificates inherited from $FOREIGN_LABEL" "no re-issue needed"
  else
    warn "Could not read $FOREIGN_LABEL's certificate store - Traefik will ask for new ones."
  fi
}

# The pools were written during the install but NOT applied, because containers
# were running (see configure_docker_address_pools). This is the window.
apply_address_pools() {
  grep -q '"default-address-pools"' /etc/docker/daemon.json 2>/dev/null || return 0
  spin_start "Restarting Docker so its address pools apply"
  # A daemon restart starts every `restart: always` container again, including one
  # the migration deliberately stopped to read its volume. Note them down first and
  # put them back the way they were.
  local was_down; was_down="$(docker ps -aq --filter status=exited --filter status=created 2>/dev/null || true)"
  systemctl restart docker >&9 2>&9 || true
  local i=0
  until docker info >/dev/null 2>&1; do
    i=$((i + 1))
    [ "$i" -ge 30 ] && break
    sleep 1
  done
  local c
  for c in $was_down; do
    docker ps -q --no-trunc | grep -q "^$c" && docker stop "$c" >&9 2>&9 || true
  done
  spin_ok "Docker restarted" "this host is no longer capped at ~31 networks"
}

# Recompute everything the published ports decide. Called with the real ports at
# the cutover, and with the temporary ones again if it has to be rolled back.
takeover_apply_ports() {
  PANEL_PORT="$1"
  HTTP_PORT="$2"
  HTTPS_PORT="$3"
  # The real 80/443 are public; a rollback to the interim ones goes back to loopback.
  case "$2" in 80) PROXY_BIND="" ;; *) PROXY_BIND="127.0.0.1:" ;; esac
  # `panel_url` covers both cases: with a domain, the address still has to carry
  # the temporary HTTPS port until the real one comes free.
  PUBLIC_URL="$(panel_url)"
  DEPLO_EXPOSE="$(printf '    ports:\n      - "127.0.0.1:%s:3000"' "$PANEL_PORT")"
  AGENT_BOOTSTRAP_URL="http://127.0.0.1:$PANEL_PORT"
  TAKEOVER_API="$AGENT_BOOTSTRAP_URL/api/takeover"
  write_traefik_compose
  write_panel_compose
  takeover_up_stacks
}

takeover_up_stacks() {
  docker compose -f "$DEPLO_DIR/traefik/docker-compose.yml" --env-file "$ENV_FILE" up -d >&9 2>&9 </dev/null || true
  docker compose -f "$DEPLO_DIR/docker-compose.yml" --env-file "$ENV_FILE" up -d >&9 2>&9 </dev/null || true
}

# Which container is listening on a port, when nothing in `docker ps` shows it -
# a `network_mode: host` container binds the host's port directly.
container_on_port() {
  local pid
  pid="$(ss -ltnpH 2>/dev/null | awk -v p="$1" '$4 ~ "[:.]"p"$" {print $NF}' | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | head -n1)"
  [ -n "$pid" ] || return 1
  sed -n 's#.*/docker-\([0-9a-f]\{12\}\)[0-9a-f]*\.scope.*#\1#p' "/proc/$pid/cgroup" 2>/dev/null | head -n1
}

proxy_running() {
  docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^deplo-traefik$'
}

# Traefik must have 80 and 443, and a workload of the platform being replaced can
# grab one the moment its proxy lets go - a host-network container does exactly
# that. Take the port back, from THEIRS only.
ensure_proxy_bound() {
  proxy_running && return 0
  local port cid took=0 workloads
  # Read once, and match WITHOUT a pipe: `grep -q` closes the pipe on its first
  # hit, the producer dies of SIGPIPE, and under `pipefail` a real match then
  # reads as no match at all.
  workloads="$(foreign_workloads)"
  for port in 80 443; do
    cid="$(container_on_port "$port" || true)"
    [ -n "$cid" ] || continue
    case "
$workloads
" in
      *"
$cid
"*) ;;
      *)
        warn "Port $port is held by something that is not ${FOREIGN_LABEL}'s, so Deplo's proxy cannot start."
        continue
        ;;
    esac
    step "Taking :$port back from $(docker inspect "$cid" --format '{{.Name}}' 2>/dev/null | tr -d /)"
    docker update --restart=no "$cid" >&9 2>&9 || true
    docker stop "$cid" >&9 2>&9 || true
    took=1
  done
  [ "$took" = 1 ] && takeover_up_stacks
  proxy_running || warn "Deplo's proxy is not running - the dashboard works, but no app domain will answer."
  return 0
}

takeover_cutover() {
  blank
  phase "Taking over from $FOREIGN_LABEL"

  spin_start "Stopping $FOREIGN_LABEL"
  foreign_stop
  takeover_side_door_remove
  # A swarm takes a moment to give a published port back, and binding 3000 while
  # it still holds it is how a cutover fails on a machine that was fine.
  local waited=0
  while [ "$waited" -lt 45 ]; do
    port_in_use 80 || port_in_use 443 || port_in_use 3000 || break
    sleep 1
    waited=$((waited + 1))
  done
  spin_ok "$FOREIGN_LABEL and its apps stopped" "nothing of it was removed"

  inherit_acme

  local OLD_PANEL="$PANEL_PORT" OLD_HTTP="$HTTP_PORT" OLD_HTTPS="$HTTPS_PORT"
  spin_start "Moving Deplo onto 80 and 443"
  takeover_apply_ports 3000 80 443
  spin_ok "Ports moved" "Traefik on 80/443, the dashboard behind it"

  apply_address_pools
  # The restart takes both stacks down with it, and on the way back a leftover of
  # theirs can win the race for :80 - which is how Traefik ends up dead on a
  # machine whose cutover otherwise worked.
  takeover_up_stacks
  ensure_proxy_bound

  spin_start "Waiting for the dashboard on its own ports"
  if wait_for_panel 60; then
    spin_ok "Deplo answers on $PUBLIC_URL"
    state_set takeover "done"
    state_set takeover_panel_port "$PANEL_PORT"
    state_set takeover_http_port "$HTTP_PORT"
    state_set takeover_https_port "$HTTPS_PORT"
    takeover_post "done"
    return 0
  fi
  spin_err "Deplo did not answer on $PUBLIC_URL after the move"

  # Back to where this started. Nothing of the other platform was removed, so
  # putting the ports back IS the whole rollback.
  warn "Putting the ports back and starting $FOREIGN_LABEL again."
  takeover_apply_ports "$OLD_PANEL" "$OLD_HTTP" "$OLD_HTTPS"
  foreign_start
  err "The takeover was rolled back. $FOREIGN_LABEL is running again."
  note "Logs: docker compose -f $DEPLO_DIR/docker-compose.yml logs deplo"
  note "Transcript: $UI_LOG"
  return 1
}

# Everything of the other platform, gone. Only ever from `removing`, which is a
# button in the panel behind a typed confirmation.
#
# Every target is found by a POSITIVE signal, never by a name pattern: the wrong
# answer here deletes the apps Deplo has just brought across.
platform_dir() {
  case "$1" in
    dokploy) printf '/etc/dokploy' ;;
    coolify) printf '/data/coolify' ;;
    *) printf '' ;;
  esac
}

# A container is the other platform's when it says so, or when the compose file
# it was started from lives inside the directory this removal is deleting.
foreign_workloads() {
  local dir c wd managed
  dir="$(platform_dir "$TAKEOVER")"
  [ -n "$dir" ] || return 0
  for c in $(docker ps -aq 2>/dev/null); do
    managed="$(docker inspect "$c" --format '{{index .Config.Labels "'"$TAKEOVER"'.managed"}}' 2>/dev/null || true)"
    [ "$managed" = "true" ] && { printf '%s\n' "$c"; continue; }
    wd="$(docker inspect "$c" --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' 2>/dev/null || true)"
    case "$wd" in "$dir"/*) printf '%s\n' "$c" ;; esac
  done
  # Explicit, because `set -o pipefail` reads the loop's last exit status as this
  # function's, and `foreign_workloads | grep -q` then FAILS on a real match.
  return 0
}

# The named volumes those containers actually mount, and the networks they are
# actually on - read off the containers rather than guessed from their names.
# Anything Deplo owns is filtered out even so.
foreign_volumes_of() {
  local c
  for c in "$@"; do
    docker inspect "$c" --format '{{range .Mounts}}{{if eq .Type "volume"}}{{println .Name}}{{end}}{{end}}' 2>/dev/null || true
  done | grep -vE '^(deplo|$)' | sort -u || true
}

foreign_networks_of() {
  local c
  for c in "$@"; do
    docker inspect "$c" --format '{{range $n, $v := .NetworkSettings.Networks}}{{println $n}}{{end}}' 2>/dev/null || true
  done | grep -vE '^(bridge|host|none|deplo|deplo-.*|.*_deplo.*|$)$' | sort -u || true
}

foreign_remove() {
  blank
  phase "Removing $FOREIGN_LABEL"

  local core workloads all vols nets svcs
  core="$(foreign_containers)"
  workloads="$(foreign_workloads)"
  all="$(printf '%s\n%s\n' "$core" "$workloads" | grep -v '^$' | sort -u)"

  # Read what they hold BEFORE they are gone; an id no longer exists afterwards.
  # shellcheck disable=SC2086
  vols="$(foreign_volumes_of $all)"
  # shellcheck disable=SC2086
  nets="$(foreign_networks_of $all)"

  if [ -n "$all" ]; then
    step "Removing $(printf '%s\n' "$all" | wc -l | tr -d ' ') container(s) it ran"
    # shellcheck disable=SC2086
    docker rm -f $all >&9 2>&9 || true
  fi

  # Dokploy deploys applications as SWARM SERVICES, which are not containers and
  # survive every `docker rm`. A Dokploy host has a swarm because Dokploy made it
  # one, so everything in it is its.
  if [ "$TAKEOVER" = dokploy ]; then
    svcs="$(docker service ls --format '{{.Name}}' 2>/dev/null || true)"
    if [ -n "$svcs" ]; then
      step "Removing $(printf '%s\n' "$svcs" | wc -l | tr -d ' ') swarm service(s)"
      # shellcheck disable=SC2086
      docker service rm $svcs >&9 2>&9 || true
    fi
  fi

  spin_start "Removing what it left behind"
  if [ -n "$vols" ]; then
    # shellcheck disable=SC2086
    docker volume rm -f $vols >&9 2>&9 || true
  fi
  if [ -n "$nets" ]; then
    # shellcheck disable=SC2086
    docker network rm $nets >&9 2>&9 || true
  fi
  # Only the platform's OWN images: a workload's image may be the very one Deplo
  # just deployed from, and `docker rmi` on an image in use is a refusal anyway.
  docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null \
    | grep -E "^(ghcr\.io/)?(coollabsio|dokploy)/" | xargs -r docker rmi -f >&9 2>&9 || true
  rm -rf "$(platform_dir "$TAKEOVER")"
  spin_ok "$FOREIGN_LABEL removed" "containers, volumes, networks, images and its directory"
  state_set takeover "removed"
  takeover_post "removed"
}

# Backing out. The panel has already started the other platform's services again
# and undone what it created; this takes Deplo off the machine.
takeover_uninstall() {
  note "Taking Deplo back off this machine - $FOREIGN_LABEL keeps everything."
  docker compose -f "$DEPLO_DIR/docker-compose.yml" --env-file "$ENV_FILE" down -v >&9 2>&9 || true
  docker compose -f "$DEPLO_DIR/traefik/docker-compose.yml" --env-file "$ENV_FILE" down >&9 2>&9 || true
  docker network rm deplo >&9 2>&9 || true
  if [ -x /usr/local/bin/deplo-agent ]; then
    systemctl disable --now deplo-agent >&9 2>&9 || true
    rm -f /usr/local/bin/deplo-agent
    rm -rf /var/lib/deplo-agent
  fi
  foreign_start
  rm -rf "$DEPLO_DIR"
  blank
  ok "Deplo is gone. $FOREIGN_LABEL is running again."
  note "Transcript: $UI_LOG"
}

# How long this window is willing to sit there. The migration itself is unbounded;
# this is only how long we keep asking.
TAKEOVER_POLL_S=5
TAKEOVER_WAIT_MAX_S="${DEPLO_TAKEOVER_WAIT:-7200}"

# After the ports move: the operator deploys their apps by hand and asks for the
# removal when they are satisfied. Deplo never deploys anything for them.
takeover_after_cutover() {
  local waited=0 state
  blank
  printf ' %bNext%b\n' "$C_B" "$C_OFF"
  printf '   1  Open %b%s%b - the ports are Deplo'"'"'s now.\n' "$C_ACC" "$PUBLIC_URL" "$C_OFF"
  printf '   2  Deploy your apps yourself, one at a time, and check each one.\n'
  printf '   3  When you are happy, remove %s from the dashboard.\n\n' "$FOREIGN_LABEL"
  note "$FOREIGN_LABEL is stopped but still on the disk, volumes and all - that is your way back."
  note "In no hurry? Close this window and re-run $DEPLO_DIR/install.sh to remove it later."

  spin_start "Waiting in case you ask for $FOREIGN_LABEL to be removed"
  while [ "$waited" -lt "$TAKEOVER_WAIT_MAX_S" ]; do
    state="$(takeover_field "$(takeover_get)" state)"
    case "$state" in
      removing)
        spin_kill
        foreign_remove
        return 0
        ;;
      removed)
        spin_kill
        ok "$FOREIGN_LABEL is already removed"
        return 0
        ;;
    esac
    sleep "$TAKEOVER_POLL_S"
    waited=$((waited + TAKEOVER_POLL_S))
  done
  spin_kill
  ok "$FOREIGN_LABEL is stopped and still on the disk"
  note "Remove it whenever you like: re-run $DEPLO_DIR/install.sh and ask from the dashboard."
  return 0
}

takeover_wait() {
  local waited=0 said_unreachable=0 mute=0 said_mute=0 body state
  blank
  printf ' %bNext%b\n' "$C_B" "$C_OFF"
  printf '   1  From your own machine:  %bssh -L %s:localhost:%s root@%s%b\n' "$C_ACC" "$PANEL_PORT" "$PANEL_PORT" "$SERVER_IP" "$C_OFF"
  printf '   2  Open %bhttp://localhost:%s%b and create your account.\n' "$C_ACC" "$PANEL_PORT" "$C_OFF"
  printf '   3  Bring your projects over from %s.\n' "$FOREIGN_LABEL"
  printf '   4  Leave this window open - it takes the ports when you say so.\n\n'
  note "Deplo answers on loopback only until it takes 80 and 443."
  note "No certificate can issue until then, so the browser warns once."
  note "Closing this window is safe: re-run $DEPLO_DIR/install.sh to pick it back up."

  spin_start "Waiting for the migration"
  while [ "$waited" -lt "$TAKEOVER_WAIT_MAX_S" ]; do
    body="$(takeover_get)"
    state="$(takeover_field "$body" state)"
    case "$state" in
      ready)
        spin_kill
        takeover_cutover || return 1
        takeover_after_cutover
        return 0
        ;;
      cancelled)
        spin_kill
        blank
        warn "The migration was cancelled from the dashboard."
        takeover_side_door_remove
        takeover_uninstall
        return 1
        ;;
      done | removing | removed)
        # Somebody else carried it past this point - a second window, or a re-run.
        spin_kill
        ok "The takeover is already past this point"
        return 0
        ;;
    esac
    # An EMPTY answer is the panel not talking to this window at all, which is a
    # different problem from a slow operator and has to say so - otherwise the
    # only symptom is a spinner that never stops.
    if [ -z "$body" ]; then
      mute=$((mute + TAKEOVER_POLL_S))
      if [ "$said_mute" = 0 ] && [ "$mute" -ge 90 ]; then
        spin_kill
        blank
        warn "The dashboard is not answering this window."
        note "It may still be starting. If this stays, its logs are:"
        note "  docker compose -f $DEPLO_DIR/docker-compose.yml logs deplo"
        note "Re-run $DEPLO_DIR/install.sh once it is up."
        said_mute=1
        spin_start "Waiting for the migration"
      fi
    else
      mute=0
      # A panel nobody has ever opened is usually a closed port, not a slow operator.
      if [ "$said_unreachable" = 0 ] && [ "$waited" -ge 90 ] &&
        [ "$(takeover_field "$body" seenExternalRequest)" = false ]; then
        spin_kill
        takeover_unreachable_advice
        said_unreachable=1
        spin_start "Waiting for the migration"
      fi
    fi
    sleep "$TAKEOVER_POLL_S"
    waited=$((waited + TAKEOVER_POLL_S))
  done
  spin_kill
  warn "Nothing happened for $((TAKEOVER_WAIT_MAX_S / 60)) minutes, so this window is done waiting."
  note "The migration is not lost - re-run $DEPLO_DIR/install.sh when you are ready."
  return 0
}

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
[ "$USE_DOMAIN" = true ] && card_kv "Backup address" "https://$FALLBACK_HOST"
card_kv "Version" "$VERSION_LABEL"
card_kv "Data dir" "$DEPLO_DIR"
card_kv "Database" "Postgres, private network only"
card_kv "Proxy" "Traefik, ports $HTTP_PORT/$HTTPS_PORT, automatic HTTPS"
[ "$HOST_ENROLLED" = true ] && card_kv "Server" "${HOST_NAME:-$SERVER_IP}, this machine"
card_close

# The DNS, certificate and callback notes. A takeover gets them too: on a machine
# whose ports have just changed hands they matter more, not less.
closing_notes() {
  if [ "$USE_DOMAIN" = true ]; then
    note "Point $DEPLO_DOMAIN at $TARGET_IP; the certificate issues on the first request."
    note "$FALLBACK_HOST answers too, so the panel stays reachable while its DNS moves."
  else
    note "$FALLBACK_HOST already resolves to this server, so there is no DNS to set up."
    note "The browser warns about the certificate: no authority issues one for a nip.io"
    note "address. To use your own domain, re-run with --domain <your domain>."
  fi
  note "Locked out? ssh -L $PANEL_PORT:localhost:$PANEL_PORT root@$SERVER_IP, then open http://localhost:$PANEL_PORT"
  note "GitHub must be able to reach $PUBLIC_URL for callbacks and webhooks."
}

# A takeover writes its own "Next" - the ordinary one would tell somebody to go
# and deploy an app on a machine whose ports still belong to another panel. Past
# the cutover it waits on the dashboard's "Remove" button, which is the one thing
# left that only root on this host can do.
if [ -n "$TAKEOVER" ]; then
  FOREIGN_LABEL="$(platform_label "$TAKEOVER")"
  case "$TAKEOVER_STATE" in
    ready)
      if takeover_cutover; then takeover_after_cutover; closing_notes; fi
      ;;
    done | removing) takeover_after_cutover; closing_notes ;;
    *) if takeover_wait; then closing_notes; fi ;;
  esac
  [ "$UI_LOG" = /dev/null ] || note "Transcript: $UI_LOG"
  printf '\n'
  exit 0
fi

printf ' %bNext%b\n' "$C_B" "$C_OFF"
if [ "$MODE" != update ]; then
  printf '   1  Open %b%s%b and create your account.\n' "$C_ACC" "$PUBLIC_URL" "$C_OFF"
  printf '   2  Connect a repository from Settings > Git.\n'
  printf '   3  Deploy your first app.\n\n'
else
  printf '   Open %b%s%b - your apps kept running throughout.\n\n' "$C_ACC" "$PUBLIC_URL" "$C_OFF"
fi

closing_notes
[ "$UI_LOG" = /dev/null ] || note "Transcript: $UI_LOG"
printf '\n'
