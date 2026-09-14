import "server-only";

import { CleanupScope } from "../../agent/gen/agent";

/** The Hello capability an agent advertises once it creates the stack's network. */
export const NETWORK_CAPABILITY = "deploy.network";

/** Dump/restore to S3 (mirrors the "backup" entry in the agent's server.Capabilities). */
export const BACKUP_CAPABILITY = "backup";

/** Holding artifacts on THIS host's disk (the StoreTarget arms plus ReadStoreFile /
 *  WriteStoreFile / RestoreFrom). */
export const BACKUP_STORE_CAPABILITY = "backup-store";

/** The agent honours `age_recipient` for a BUCKET artifact (and reports a sha256). */
export const BACKUP_ENCRYPT_S3_CAPABILITY = "backup-encrypt-s3";

/** The agent reads `S3Target.extra_args` - a destination's advanced quirk flags reach
 *  its minio client instead of being ignored. */
export const BACKUP_S3_ARGS_CAPABILITY = "backup-s3-args";

/** `ReadStoreFile` accepts an S3Target, so an artifact in a BUCKET can be streamed
 *  back out decrypted. A HARD gate. */
export const BACKUP_S3_READ_CAPABILITY = "backup-s3-read";

/** `RestoreFrom` honours `untrusted_config`: an artifact from OUTSIDE the fleet
 *  contributes data only, never the compose/env/mounts. A HARD gate. */
export const BACKUP_UNTRUSTED_CONFIG_CAPABILITY = "backup-untrusted-config";

/** StartJob/PollJob/KillJob - ADR-0018. */
export const CRON_CAPABILITY = "cron";

/** The long-lived telemetry stream behind `streamMetrics`. */
export const METRICS_STREAM_CAPABILITY = "metrics-stream";

/** The agent brings a compose stack up from the stack's OWN directory
 *  (`--project-directory`), with its env-file as `.env` inside it. */
export const COMPOSE_PROJECTDIR_CAPABILITY = "deploy.compose.projectdir";

/** `FollowLogsRequest` carries `since_unix` / `until_unix` / `timestamps`. A SOFT
 *  gate: an agent without it still streams, the UI greys the control out. */
export const LOGS_TIMERANGE_CAPABILITY = "logs.timerange";

/** `VolumeUsage` - the measured size behind a database's Data card. */
export const VOLUME_USAGE_CAPABILITY = "volume-usage";

/** In-place self-update (mirrors "self-update" in the agent's server.Capabilities). */
export const SELF_UPDATE_CAPABILITY = "self-update";

/** Removing its own footprint from the host. */
export const SELF_UNINSTALL_CAPABILITY = "self-uninstall";

/** Reclaiming Docker disk. Exported so the readiness report can name the gap
 *  before anyone clicks. */
export const DOCKER_CLEANUP_CAPABILITY = "docker-cleanup";

/** Gates `DockerCleanupRequest.keep_per_slug` - per-APP image retention, which is
 *  what carries each app's rollback depth. */
export const CLEANUP_KEEP_PER_SLUG_CAPABILITY = "cleanup.keep-per-slug";

/** The Hello capability each scope needs, for the scopes that have one. An agent
 *  answers an unknown scope with INVALID_ARGUMENT, which fails the WHOLE sweep. */
export const CLEANUP_SCOPE_CAPABILITY: Partial<Record<CleanupScope, string>> = {
  [CleanupScope.CLEANUP_SCOPE_LEFTOVER_APP_FILES]: "cleanup.leftover-files",
  [CleanupScope.CLEANUP_SCOPE_LEFTOVER_NETWORKS]: "cleanup.leftover-networks",
  [CleanupScope.CLEANUP_SCOPE_ORPHAN_VOLUMES]: "cleanup.orphan-volumes",
  [CleanupScope.CLEANUP_SCOPE_UNUSED_PULLED_IMAGES]: "cleanup.pulled-images",
};

/** The four host-level RPCs (host info, clock, Traefik, panel restart). */
export const HOSTOPS_CAPABILITY = "hostops";

/** The agent can update the panel on its host. */
export const CONTROL_PLANE_UPDATE_CAPABILITY = "control-plane.update";
