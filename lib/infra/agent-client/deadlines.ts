import "server-only";

export const HELLO_TIMEOUT_MS = 8_000;
// The Hello deadline the HEALTH PROBER uses - much shorter than HELLO_TIMEOUT_MS,
// which is a deploy pre-flight budget spent on a deploy already committed to.
export const HEALTH_HELLO_TIMEOUT_MS = 3_000;
export const DEPLOY_DEADLINE_MS = 30 * 60_000; // a build can be long
export const CONSOLE_TIMEOUT_MS = 30_000; // exec runs in-container; match docker.ts exec
// StartJob gets the more generous budget: it crosses a possibly-slow link with the
// command and its environment attached.
export const CRON_START_TIMEOUT_MS = 15_000;
export const CRON_POLL_TIMEOUT_MS = 10_000;
export const METRICS_TIMEOUT_MS = 8_000;
export const FILES_TIMEOUT_MS = 15_000;
export const STREAM_DEADLINE_MS = 30 * 60_000; // logs/attach are long-lived
// Its own constant because STREAM_DEADLINE_MS would tear the telemetry stream down
// every 30 minutes, and this one stays open for the life of the process.
export const METRICS_STREAM_DEADLINE_MS = 55 * 60_000;
/** How many unread telemetry frames to hold before dropping the oldest. */
export const METRICS_STREAM_MAX_QUEUED = 4;
// The agent caps each backup step at ~30min; this is that plus dial slack.
export const BACKUP_DEADLINE_MS = 60 * 60_000;
/** How long a `running` backup run may sit before the boot reconcile calls it orphaned. */
export const BACKUP_RUN_MAX_MS = BACKUP_DEADLINE_MS + 30 * 60_000;
// A slow/unreachable S3 endpoint must time out rather than hang the request.
export const S3_OP_DEADLINE_MS = 60_000;
export const SELF_UPDATE_TIMEOUT_MS = 2 * 60_000; // download + verify + swap the binary
export const SELF_UNINSTALL_TIMEOUT_MS = 60_000;
// Mandatory: stack verbs run under the per-DB lifecycle lock (lib/data/keyed-mutex),
// so a hung RPC with no deadline would wedge every future op for that database.
export const STACK_DEADLINE_MS = 3 * 60_000;
// The agent caps each side of a copy at 6h; an hour wider so the agent's own timeout
// fires and its message names the step.
export const VOLUME_COPY_DEADLINE_MS = 7 * 60 * 60_000;
/** How many BYTE-carrying frames a relay may hold before it pauses the source stream. */
export const STREAM_BYTES_PAUSE_ABOVE = 8;
// Short on purpose: this gates an interactive "generate available port" click.
export const CHECK_PORT_DEADLINE_MS = 15_000;
// Icon detection is the only caller - a cosmetic read that must never hold a deploy
// or a settings click open waiting on a slow app.
export const PROBE_HTTP_DEADLINE_MS = 12_000;
// A sweep unlinks every image, volume and cache record one at a time - tens of GB.
export const CLEANUP_DEADLINE_MS = 30 * 60_000;
// Interactive: an unresponsive host must fail fast rather than hold a settings page.
export const HOSTOPS_DEADLINE_MS = 20_000;
/** The installer is fetched inside the call; the run it starts is not waited on. */
export const CONTROL_PLANE_UPDATE_DEADLINE_MS = 60_000;
// A config change pulls an image and recreates the container; the agent caps its own
// docker call at 180s, so allow for that plus the round trip.
export const TRAEFIK_DEADLINE_MS = 200_000;
/** A du-class walk is O(files); the agent bounds it at 60s, this leaves headroom. */
export const VOLUME_USAGE_TIMEOUT_MS = 70_000;
