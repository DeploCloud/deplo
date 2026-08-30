import { builder } from "../builder";
import {
  getFleetMetrics,
  getServerMetrics,
  getServerMetricsHistory,
  type FleetServerMetrics,
  type FleetSpark,
  type ServerMetrics,
} from "@/lib/data/monitoring";
import {
  getMonitoringSettings,
  setSaveMetrics,
  type MonitoringSettings,
} from "@/lib/data/monitoring-settings";
import {
  getAppMetrics,
  getAppMetricsHistory,
  getDatabaseMetrics,
  getDatabaseMetricsHistory,
  type ContainerMetrics,
  type ContainerMetricsSample,
  type ContainerInstanceMetrics,
} from "@/lib/data/container-metrics";

/* ------------------------------------------------------------------ */
/* Object types                                                        */
/* ------------------------------------------------------------------ */

const ServerMetricsRef = builder
  .objectRef<ServerMetrics>("ServerMetrics")
  .implement({
    description:
      "A live resource-usage snapshot for one server (CPU, memory, disk, " +
      "network, load and running-container count).",
    fields: (t) => ({
      serverId: t.exposeID("serverId"),
      online: t.exposeBoolean("online"),
      // Live Traefik state, so the badge updates with the poll (no reload).
      traefik: t.exposeBoolean("traefik"),
      cpu: t.exposeFloat("cpu"),
      cpuCores: t.exposeInt("cpuCores"),
      memUsed: t.exposeFloat("memUsed"),
      memTotal: t.exposeFloat("memTotal"),
      memPct: t.exposeFloat("memPct"),
      memFree: t.exposeFloat("memFree", {
        description:
          "MemFree. `memUsed` is total-available (what `free` calls used), so " +
          "this and `memCache` are what let the tile show the reclaimable half.",
      }),
      memCache: t.exposeFloat("memCache", {
        description: "Buffers + Cached + SReclaimable.",
      }),
      diskUsed: t.exposeFloat("diskUsed"),
      diskTotal: t.exposeFloat("diskTotal"),
      diskPct: t.exposeFloat("diskPct"),
      netRx: t.exposeFloat("netRx"),
      netTx: t.exposeFloat("netTx"),
      // load is the [1m, 5m, 15m] tuple - expose as a list of floats.
      load: t.field({
        type: ["Float"],
        description: "Load averages over [1m, 5m, 15m].",
        resolve: (m) => m.load,
      }),
      uptimeSec: t.exposeInt("uptimeSec"),
      containers: t.exposeInt("containers"),
      // Live agent-version pair, so the version badge and the "Update agent"
      // target update with the poll rather than waiting for a reload.
      agentVersion: t.exposeString("agentVersion", { nullable: true }),
      expectedAgentVersion: t.exposeString("expectedAgentVersion"),
      source: t.exposeString("source", {
        description:
          'Which sampler produced this frame: "cgroup2" | "docker-stats". Empty ' +
          "when the reading did not come from the telemetry stream.",
      }),
      // Epoch milliseconds; expose as Float to avoid 32-bit Int overflow.
      ts: t.exposeFloat("ts"),
    }),
  });

/* ---- Per-app / per-database container metrics (the Monitoring TAB) ---- */

const ContainerInstanceMetricsRef = builder
  .objectRef<ContainerInstanceMetrics>("ContainerInstanceMetrics")
  .implement({
    description:
      "Live resource usage for ONE container of an app/database stack - the " +
      "Monitoring tab's per-container breakdown. net_* / block_* are cumulative " +
      "byte counters since the container started.",
    fields: (t) => ({
      name: t.exposeString("name"),
      running: t.exposeBoolean("running"),
      cpu: t.exposeFloat("cpu"),
      memUsed: t.exposeFloat("memUsed"),
      memLimit: t.exposeFloat("memLimit"),
      memPct: t.exposeFloat("memPct"),
      netRx: t.exposeFloat("netRx"),
      netTx: t.exposeFloat("netTx"),
      blockRead: t.exposeFloat("blockRead"),
      blockWrite: t.exposeFloat("blockWrite"),
      pids: t.exposeInt("pids"),
      state: t.exposeString("state", {
        description:
          "Raw docker state: running | restarting | exited | created | paused | " +
          "dead | removing. Empty from an agent too old to report it.",
      }),
      health: t.exposeString("health", {
        description:
          "The healthcheck verdict when the image defines one: healthy | " +
          "unhealthy | starting. EMPTY means there is no healthcheck at all, " +
          "which is not a synonym for healthy.",
      }),
      restartCount: t.exposeInt("restartCount", {
        description:
          "How many times docker has restarted this container - what tells a " +
          "container that is starting from one that has been dying for an hour.",
      }),
      netNsHost: t.exposeBoolean("netNsHost", {
        description:
          "This container is on the host's network (`network_mode: host`), so " +
          "net_rx/net_tx are 0 here - its traffic is the machine's, on the " +
          "server's own network chart.",
      }),
      netNsId: t.exposeFloat("netNsId", {
        description:
          "The container's network namespace. Two containers reporting the same " +
          "one (a sidecar on `network_mode: service:x`) read the SAME counters, " +
          "and the stack total counts them once. 0 from an older agent.",
      }),
    }),
  });

const ContainerMetricsSampleRef = builder
  .objectRef<ContainerMetricsSample>("ContainerMetricsSample")
  .implement({
    description:
      "One buffered aggregate metrics sample for an app/database stack (the sum " +
      "across its running containers) - what the Monitoring tab's charts seed " +
      "from. net_* / block_* are cumulative bytes; the client derives bytes/sec " +
      "from the delta between consecutive samples.",
    fields: (t) => ({
      id: t.exposeID("id"),
      online: t.exposeBoolean("online"),
      // Epoch milliseconds; Float to avoid 32-bit Int overflow, like ServerMetrics.
      ts: t.exposeFloat("ts"),
      cpu: t.exposeFloat("cpu"),
      memUsed: t.exposeFloat("memUsed"),
      memLimit: t.exposeFloat("memLimit"),
      memPct: t.exposeFloat("memPct"),
      netRx: t.exposeFloat("netRx"),
      netTx: t.exposeFloat("netTx"),
      blockRead: t.exposeFloat("blockRead"),
      blockWrite: t.exposeFloat("blockWrite"),
      pids: t.exposeInt("pids"),
      running: t.exposeInt("running"),
      containers: t.exposeInt("containers"),
      hostCores: t.exposeInt("hostCores", {
        description:
          "The owning machine's core count. `cpu` is a percentage of ONE core " +
          "(like `docker stats` and htop), so 299% is three busy cores of this " +
          "many. 0 before the first frame.",
      }),
    }),
  });

const ContainerMetricsRef = builder
  .objectRef<ContainerMetrics>("ContainerMetrics")
  .implement({
    description:
      "A fresh live metrics snapshot for one app/database stack: the aggregate " +
      "across its containers, plus the per-container breakdown and an " +
      "`unsupported` flag (the owning server's agent is too old for per-container " +
      "metrics - the tab shows 'update the agent').",
    fields: (t) => ({
      id: t.exposeID("id"),
      online: t.exposeBoolean("online"),
      unsupported: t.exposeBoolean("unsupported"),
      ts: t.exposeFloat("ts"),
      cpu: t.exposeFloat("cpu"),
      memUsed: t.exposeFloat("memUsed"),
      memLimit: t.exposeFloat("memLimit"),
      memPct: t.exposeFloat("memPct"),
      netRx: t.exposeFloat("netRx"),
      netTx: t.exposeFloat("netTx"),
      blockRead: t.exposeFloat("blockRead"),
      blockWrite: t.exposeFloat("blockWrite"),
      pids: t.exposeInt("pids"),
      running: t.exposeInt("running"),
      containers: t.exposeInt("containers"),
      hostCores: t.exposeInt("hostCores", {
        description: "The owning machine's core count - see the sample type.",
      }),
      instances: t.field({
        type: [ContainerInstanceMetricsRef],
        description: "Per-container usage (multi-container stacks). Live only.",
        resolve: (m) => m.instances,
      }),
    }),
  });

const FleetSparkRef = builder.objectRef<FleetSpark>("FleetSpark").implement({
  description: "One thinned point of a fleet row's sparkline.",
  fields: (t) => ({
    ts: t.exposeFloat("ts"),
    cpu: t.exposeFloat("cpu"),
    mem: t.exposeFloat("mem"),
  }),
});

const FleetServerMetricsRef = builder
  .objectRef<FleetServerMetrics>("FleetServerMetrics")
  .implement({
    description:
      "One server's headline reading for the Monitoring page's fleet list, plus " +
      "a thinned CPU/memory trace.",
    fields: (t) => ({
      serverId: t.exposeID("serverId"),
      online: t.exposeBoolean("online", {
        description: "Whether the buffer holds a reading at all.",
      }),
      ts: t.exposeFloat("ts", {
        description:
          "Newest sample time, epoch ms. 0 means nothing has been measured - the " +
          "row says so rather than drawing zeros.",
      }),
      cpu: t.exposeFloat("cpu"),
      memPct: t.exposeFloat("memPct"),
      diskPct: t.exposeFloat("diskPct"),
      containers: t.exposeInt("containers"),
      agentVersion: t.exposeString("agentVersion", { nullable: true }),
      expectedAgentVersion: t.exposeString("expectedAgentVersion"),
      source: t.exposeString("source"),
      spark: t.field({
        type: [FleetSparkRef],
        description: "Oldest first, at most 30 points.",
        resolve: (m) => m.spark,
      }),
    }),
  });

const MonitoringSettingsRef = builder
  .objectRef<MonitoringSettings>("MonitoringSettings")
  .implement({
    description:
      "Instance-wide monitoring settings (a fleet-scoped singleton, like the " +
      "Docker cleanup policy).",
    fields: (t) => ({
      // Whether the control plane keeps a rolling in-memory metrics history per
      // server, so the Monitoring charts survive a page reload.
      saveMetrics: t.exposeBoolean("saveMetrics"),
      updatedAt: t.exposeString("updatedAt", { nullable: true }),
    }),
  });

/* ------------------------------------------------------------------ */
/* Queries (the polling actions - serverMetrics)                       */
/* ------------------------------------------------------------------ */

builder.queryFields((t) => ({
  serverMetrics: t.field({
    type: ServerMetricsRef,
    // Every call dials the owning server's agent (fresh mTLS connect + cert work) with
    // no rate limit - an infra action, not a dashboard read.
    authScopes: { capability: "view_metrics" },
    description: "A fresh live metrics snapshot for one server.",
    args: { serverId: t.arg.string({ required: true }) },
    resolve: (_r, { serverId }) => getServerMetrics(serverId),
  }),
  serverMetricsHistory: t.field({
    type: [ServerMetricsRef],
    authScopes: { capability: "view_metrics" },
    description:
      "The metrics history buffered on the control plane for one server (oldest " +
      "first) - what the Monitoring charts seed from on load. Empty when saving " +
      "is off or the control plane restarted recently.",
    args: { serverId: t.arg.string({ required: true }) },
    resolve: (_r, { serverId }) => getServerMetricsHistory(serverId),
  }),
  fleetMetrics: t.field({
    type: [FleetServerMetricsRef],
    authScopes: { capability: "view_metrics" },
    description:
      "Every server's newest reading plus a thinned trace, for the Monitoring " +
      "page's fleet list. Reads the control plane's buffers only - no agent is " +
      "dialled, so watching N hosts costs what watching one does.",
    resolve: () => getFleetMetrics(),
  }),
  monitoringSettings: t.field({
    type: MonitoringSettingsRef,
    authScopes: { loggedIn: true },
    description: "The instance-wide monitoring settings.",
    resolve: () => getMonitoringSettings(),
  }),

  // Per-app / per-database live metrics (the Monitoring tab). Team-scoped in the
  // data layer (null for an unknown/cross-team id); polled ~1s like serverMetrics.
  appMetrics: t.field({
    type: ContainerMetricsRef,
    nullable: true,
    authScopes: { capability: "view_metrics" },
    description: "A fresh live per-container metrics snapshot for one app.",
    args: { appId: t.arg.string({ required: true }) },
    resolve: (_r, { appId }) => getAppMetrics(appId),
  }),
  appMetricsHistory: t.field({
    type: [ContainerMetricsSampleRef],
    authScopes: { capability: "view_metrics" },
    description:
      "The metrics history buffered for one app (oldest first) - what the app's " +
      "Monitoring charts seed from. Empty when the owning server's telemetry " +
      "stream has not delivered a frame for it yet.",
    args: { appId: t.arg.string({ required: true }) },
    resolve: (_r, { appId }) => getAppMetricsHistory(appId),
  }),
  databaseMetrics: t.field({
    type: ContainerMetricsRef,
    nullable: true,
    authScopes: { capability: "view_metrics" },
    description:
      "A fresh live per-container metrics snapshot for one database.",
    args: { databaseId: t.arg.string({ required: true }) },
    resolve: (_r, { databaseId }) => getDatabaseMetrics(databaseId),
  }),
  databaseMetricsHistory: t.field({
    type: [ContainerMetricsSampleRef],
    authScopes: { capability: "view_metrics" },
    description:
      "The metrics history buffered for one database (oldest first). Empty when " +
      "the owning server's telemetry stream has not delivered a frame for it yet.",
    args: { databaseId: t.arg.string({ required: true }) },
    resolve: (_r, { databaseId }) => getDatabaseMetricsHistory(databaseId),
  }),
}));

/* ------------------------------------------------------------------ */
/* Mutations                                                           */
/* ------------------------------------------------------------------ */

builder.mutationFields((t) => ({
  setSaveMetrics: t.field({
    type: MonitoringSettingsRef,
    // Instance-wide infra, the cleanup-policy gate; enforced again in the data
    // layer (defense in depth).
    authScopes: { capability: "manage_monitoring" },
    description:
      "Turn saving server metrics on the control plane on or off. Turning it " +
      "off also drops the buffered history.",
    args: { enabled: t.arg.boolean({ required: true }) },
    resolve: (_r, { enabled }) => setSaveMetrics(enabled),
  }),

  // There is deliberately NO per-app / per-database "Save metrics" mutation.
}));
