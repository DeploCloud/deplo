import type { ID } from "./identity";

// MOUNT_PROPAGATIONS - how mounts appearing UNDERNEATH a bind mount cross
// between the server and the container.
export const MOUNT_PROPAGATIONS = ["rslave", "rshared"] as const;
export type MountPropagation = (typeof MOUNT_PROPAGATIONS)[number];

// VolumeMount - a persistent volume mounted into an app's container.
export interface VolumeMount {
  // Stable id (server: newId("vol"); client draft rows: vol_<shortId>), so a
  // rename of `name` does not look like delete+create.
  id: ID;
  // Absent ⇒ "named" (docker-managed), so documents written before host bind
  // mounts existed keep rendering identically.
  type?: "named" | "app" | "host";
  // Human label, lowercase-kebab, UNIQUE PER PROJECT. Namespaced on the host.
  // Named volumes only (ignored for "app"/"host" mounts).
  name: string;
  // Path RELATIVE to the project's isolated files dir. App mounts only
  // (type === "app"); never contains "..".
  projectPath?: string;
  // Absolute HOST path to bind-mount. Host mounts only (type === "host").
  hostPath?: string;
  // COMPOSE-STACK apps only: the compose service to mount into. Empty/absent ⇒
  // the stack's default service (a published port, else the first).
  service?: string | null;
  // Absolute in-container mount path. UNIQUE PER PROJECT, or, for a compose
  // stack, unique per (service, path).
  mountPath: string;
  // Mount read-only (`:ro`). Defaults to false (read-write).
  readOnly: boolean;
  // HOST binds only: whether the mount follows submounts that appear later.
  propagation?: MountPropagation;
}

// MAX_PUBLISHED_PORTS - how many host ports one app may publish. Bounded because
// each one is a real listener on a shared machine.
export const MAX_PUBLISHED_PORTS = 20;

// PublishedPort - one `published:target/protocol` compose `ports:` entry, for an
// app that does not speak HTTP.
export interface PublishedPort {
  // Stable id (server: newId("prt"); client draft rows: prt_<shortId>).
  id: ID;
  // The port on the HOST. Unique per server.
  published: number;
  // The port inside the container.
  target: number;
  protocol: "tcp" | "udp";
}

// ResourceLimits - caps applied at deploy time so a runaway app can't starve its
// neighbours on a shared host.
export interface ResourceLimits {
  // Hard RAM ceiling, MiB → `mem_limit`. The container is OOM-killed above it.
  memoryMb: number | null;
  // Soft RAM reservation, MiB → `mem_reservation` (a hint, not a cap).
  memoryReservationMb: number | null;
  // Memory + swap ceiling, MiB → `memswap_limit`. Must be ≥ `memoryMb`.
  swapMb: number | null;
  // Hard CPU ceiling in milli-CPUs (1000 = one core) → `cpus`.
  cpuMilli: number | null;
  // Relative CPU weight under contention, 2-262144 → `cpu_shares`.
  cpuShares: number | null;
  // Pin to specific host cores, e.g. "0,2-3" → `cpuset`.
  cpuset: string | null;
  // Max processes/threads (fork-bomb guard) → `pids_limit`.
  pidsLimit: number | null;
  // `/dev/shm` size, MiB → `shm_size`.
  shmSizeMb: number | null;
  // Writable-layer disk quota, GiB → `storage_opt.size`.
  storageGb: number | null;
  // Max open file descriptors → `ulimits.nofile` (soft = hard).
  nofile: number | null;
  // Max processes for the container user → `ulimits.nproc` (soft = hard).
  nproc: number | null;
  // OOM-killer priority, -1000..1000 → `oom_score_adj` (higher = killed first).
  oomScoreAdj: number | null;
}

// HealthCheck - the compose `healthcheck:` block Docker runs inside the
// container; the status dot follows what it says.
// See https://deplo.build/docs/guides/observability/monitoring
export interface HealthCheck {
  // `http` asks the app over localhost; `command` runs whatever you give it.
  type: "http" | "command";
  // http only. The path to request, e.g. `/healthz`.
  path: string | null;
  // http only. The port INSIDE the container; the app's own port when null.
  port: number | null;
  // command only. Run through a shell, so a pipe or a `||` works.
  command: string | null;
  // Seconds between checks.
  intervalS: number;
  // Seconds one check may take before it counts as a failure.
  timeoutS: number;
  // Consecutive failures before the container is called unhealthy.
  retries: number;
  // Seconds of grace while the app starts, during which a failure does not count.
  startPeriodS: number;
}
