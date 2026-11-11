import "server-only";

import { CleanupScope } from "../../agent/gen/agent";

export const NETWORK_CAPABILITY = "deploy.network";

export const BACKUP_CAPABILITY = "backup";

export const BACKUP_STORE_CAPABILITY = "backup-store";

export const BACKUP_ENCRYPT_S3_CAPABILITY = "backup-encrypt-s3";

export const BACKUP_S3_ARGS_CAPABILITY = "backup-s3-args";

export const BACKUP_S3_READ_CAPABILITY = "backup-s3-read";

// Hard gate: with it the agent takes only DATA from an outside-the-fleet artifact, never its compose/env/mounts.
export const BACKUP_UNTRUSTED_CONFIG_CAPABILITY = "backup-untrusted-config";

// A Redis that runs append-only reloads the append-only file after a restore, so an older agent restores into a dataset that comes back empty.
export const BACKUP_REDIS_AOF_CAPABILITY = "backup.redis-aof";

// A Postgres base backup, its change log, and the restore that replays both (#203).
export const POSTGRES_ARCHIVE_CAPABILITY = "backup.postgres-archive";

export const CRON_CAPABILITY = "cron";

export const METRICS_STREAM_CAPABILITY = "metrics-stream";

export const COMPOSE_PROJECTDIR_CAPABILITY = "deploy.compose.projectdir";

export const LOGS_TIMERANGE_CAPABILITY = "logs.timerange";

export const VOLUME_USAGE_CAPABILITY = "volume-usage";

export const SELF_UPDATE_CAPABILITY = "self-update";

export const SELF_UNINSTALL_CAPABILITY = "self-uninstall";

export const DOCKER_CLEANUP_CAPABILITY = "docker-cleanup";

export const CLEANUP_SAFE_PRUNE_CAPABILITY = "cleanup.safe-prune";

export const CLEANUP_KEEP_PER_SLUG_CAPABILITY = "cleanup.keep-per-slug";

// An agent answers an unknown scope with INVALID_ARGUMENT, which fails the whole sweep.
export const CLEANUP_SCOPE_CAPABILITY: Partial<Record<CleanupScope, string>> = {
  [CleanupScope.CLEANUP_SCOPE_LEFTOVER_APP_FILES]: "cleanup.leftover-files",
  [CleanupScope.CLEANUP_SCOPE_LEFTOVER_NETWORKS]: "cleanup.leftover-networks",
  [CleanupScope.CLEANUP_SCOPE_ORPHAN_VOLUMES]: "cleanup.orphan-volumes",
  [CleanupScope.CLEANUP_SCOPE_UNUSED_PULLED_IMAGES]:
    CLEANUP_SAFE_PRUNE_CAPABILITY,
};

export const HOSTOPS_CAPABILITY = "hostops";

export const CONTROL_PLANE_UPDATE_CAPABILITY = "control-plane.update";

// An older agent refuses any version that is not x.y.z, so a canary would fail at the host.
export const CONTROL_PLANE_UPDATE_CANARY_CAPABILITY =
  "control-plane.update.canary";

// Without it StopStack can only stop a WHOLE stack, so the restart-loop guard leaves a multi-service stack alone.
export const STOP_SERVICES_CAPABILITY = "stack.stop-services";

// Without it Hello's public_addresses is empty for want of the field, not for want of an address.
export const HOST_ADDRESSES_CAPABILITY = "host.addresses";

// Without it the agent ignores files_bind_sources and mounts a link out of the app's files as-is.
export const FILES_BIND_CHECK_CAPABILITY = "deploy.files-bind-check";

// ADR-0038: ListWorkloadImages + InventoryImage, the package read behind Security updates.
export const IMAGE_INVENTORY_CAPABILITY = "image-inventory";
// InventoryCandidate: a newer build is read before Update is offered.
export const IMAGE_CANDIDATE_CAPABILITY = "image-inventory.candidate";
// The package list marks build-only packages and who pulls each in (lockfile graph).
export const IMAGE_DEPS_CAPABILITY = "image-inventory.deps";
// It also marks the packages the app's package.json names, and follows bun.lock's peers.
export const IMAGE_DIRECT_CAPABILITY = "image-inventory.direct";

export const DEPLOY_PULL_BASE_CAPABILITY = "deploy.pull-base";

// Without it a reroute pulls only missing images, so a database Update would change nothing.
export const REROUTE_PULL_CAPABILITY = "reroute.pull";

// The deploy's restart rule: the agent restarts an app that stops answering.
export const RESTART_CAPABILITY = "health.restart";

// CaptureScreenshot: the deployment screenshot browser (ADR-0039).
export const SCREENSHOT_CAPABILITY = "screenshot";

// The agent links to the panel (ADR-0040), and with it Hello's link_addresses and SetLinkAddresses.
export const AGENT_LINK_CAPABILITY = "agent-link";

// The agent installs, runs and removes the deplo-cluster binary and forwards calls to it (ADR-0043).
export const CLUSTER_HOST_CAPABILITY = "cluster.host";

// The agent is a cluster party: it dials every relay it knows and holds one connection to each (ADR-0044).
export const CLUSTER_CAPABILITY = "cluster";

// The agent copies a built image to another member of its cluster over the relay (ADR-0044).
export const CLUSTER_IMAGES_CAPABILITY = "cluster.images";

// The agent starts a workload its cluster's leader moves to it; without it the leader's order is renewed and ignored.
export const CLUSTER_FAILOVER_CAPABILITY = "cluster.failover";

// The agent restores the bundle's backup into a moved workload before it counts as started (#202).
export const CLUSTER_FAILOVER_RESTORE_CAPABILITY = "cluster.failover.restore";

// The agent holds workloads' names on its Environments' networks and relays them to the member that runs them (#200).
export const CLUSTER_FORWARDERS_CAPABILITY = "cluster.forwarders";

// The agent holds a marked service back until the App is ready: a tunnel's connector must not send visitors to an App that is not up.
export const START_AFTER_READY_CAPABILITY = "deploy.start-after-ready";

// The agent runs a stack that declares one replica as a project, so a member can hold one replica of an App spread over several (#208).
export const SPREAD_CAPABILITY = "deploy.spread";
