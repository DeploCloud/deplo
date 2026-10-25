import "server-only";

export const HELLO_TIMEOUT_MS = 8_000;
export const HEALTH_HELLO_TIMEOUT_MS = 3_000;
export const DEPLOY_DEADLINE_MS = 30 * 60_000;
export const CONSOLE_TIMEOUT_MS = 30_000;
export const CRON_START_TIMEOUT_MS = 15_000;
export const CRON_POLL_TIMEOUT_MS = 10_000;
export const METRICS_TIMEOUT_MS = 8_000;
export const FILES_TIMEOUT_MS = 15_000;
export const STREAM_DEADLINE_MS = 30 * 60_000;
export const METRICS_STREAM_DEADLINE_MS = 55 * 60_000;
export const METRICS_STREAM_MAX_QUEUED = 4;
export const BACKUP_DEADLINE_MS = 60 * 60_000;
export const BACKUP_RUN_MAX_MS = BACKUP_DEADLINE_MS + 30 * 60_000;
// A restore downloads and checks the artifact BEFORE applying it, so the two no longer overlap.
export const RESTORE_DEADLINE_MS = 2 * BACKUP_DEADLINE_MS;
export const RESTORE_RUN_MAX_MS = RESTORE_DEADLINE_MS + 30 * 60_000;
export const S3_OP_DEADLINE_MS = 60_000;
export const SELF_UPDATE_TIMEOUT_MS = 2 * 60_000;
export const SELF_UNINSTALL_TIMEOUT_MS = 60_000;
export const STACK_DEADLINE_MS = 3 * 60_000;
export const VOLUME_COPY_DEADLINE_MS = 7 * 60 * 60_000;
export const STREAM_BYTES_PAUSE_ABOVE = 8;
export const CHECK_PORT_DEADLINE_MS = 15_000;
export const PROBE_HTTP_DEADLINE_MS = 12_000;
export const CLEANUP_DEADLINE_MS = 30 * 60_000;
export const HOSTOPS_DEADLINE_MS = 20_000;
export const CONTROL_PLANE_UPDATE_DEADLINE_MS = 60_000;
export const TRAEFIK_DEADLINE_MS = 200_000;
export const VOLUME_USAGE_TIMEOUT_MS = 70_000;
export const INVENTORY_LIST_DEADLINE_MS = 60_000;
// The agent stops its own read at 10 minutes; the margin covers the save before it.
export const INVENTORY_DEADLINE_MS = 15 * 60_000;
// The agent gives the pull itself 10 minutes before `up`.
export const REROUTE_PULL_DEADLINE_MS = 12 * 60_000;
