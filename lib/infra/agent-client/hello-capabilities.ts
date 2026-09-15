import "server-only";

import { CleanupScope } from "../../agent/gen/agent";

export const NETWORK_CAPABILITY = "deploy.network";

export const BACKUP_CAPABILITY = "backup";

export const BACKUP_STORE_CAPABILITY = "backup-store";

export const BACKUP_ENCRYPT_S3_CAPABILITY = "backup-encrypt-s3";

export const BACKUP_S3_ARGS_CAPABILITY = "backup-s3-args";

export const BACKUP_S3_READ_CAPABILITY = "backup-s3-read";

export const BACKUP_UNTRUSTED_CONFIG_CAPABILITY = "backup-untrusted-config";

export const CRON_CAPABILITY = "cron";

export const METRICS_STREAM_CAPABILITY = "metrics-stream";

export const COMPOSE_PROJECTDIR_CAPABILITY = "deploy.compose.projectdir";

export const LOGS_TIMERANGE_CAPABILITY = "logs.timerange";

export const VOLUME_USAGE_CAPABILITY = "volume-usage";

export const SELF_UPDATE_CAPABILITY = "self-update";

export const SELF_UNINSTALL_CAPABILITY = "self-uninstall";

export const DOCKER_CLEANUP_CAPABILITY = "docker-cleanup";

export const CLEANUP_KEEP_PER_SLUG_CAPABILITY = "cleanup.keep-per-slug";

export const CLEANUP_SCOPE_CAPABILITY: Partial<Record<CleanupScope, string>> = {
  [CleanupScope.CLEANUP_SCOPE_LEFTOVER_APP_FILES]: "cleanup.leftover-files",
  [CleanupScope.CLEANUP_SCOPE_LEFTOVER_NETWORKS]: "cleanup.leftover-networks",
  [CleanupScope.CLEANUP_SCOPE_ORPHAN_VOLUMES]: "cleanup.orphan-volumes",
  [CleanupScope.CLEANUP_SCOPE_UNUSED_PULLED_IMAGES]: "cleanup.pulled-images",
};

export const HOSTOPS_CAPABILITY = "hostops";

export const CONTROL_PLANE_UPDATE_CAPABILITY = "control-plane.update";
