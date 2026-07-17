import { builder } from "../builder";
import {
  getServerMetrics,
  getAllServerMetrics,
  getServerMetricsHistory,
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
  setAppSaveMetrics,
  setDatabaseSaveMetrics,
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
      diskUsed: t.exposeFloat("diskUsed"),
      diskTotal: t.exposeFloat("diskTotal"),
      diskPct: t.exposeFloat("diskPct"),
      netRx: t.exposeFloat("netRx"),
      netTx: t.exposeFloat("netTx"),
      // load is the [1m, 5m, 15m] tuple — expose as a list of floats.
      load: t.field({
        type: ["Float"],
        description: "Load averages over [1m, 5m, 15m].",
        resolve: (m) => m.load,
      }),
      uptimeSec: t.exposeInt("uptimeSec"),
      containers: t.exposeInt("containers"),
      // Live agent-version trio, so the version/outdated badge updates with the
      // poll (no reload): a "Check for updates" that resolves a newer release
      // flips every open Servers tab's badge to outdated on the next poll.
      agentVersion: t.exposeString("agentVersion", { nullable: true }),
      expectedAgentVersion: t.exposeString("expectedAgentVersion"),
      agentOutdated: t.exposeBoolean("agentOutdated"),
      // Epoch milliseconds; expose as Float to avoid 32-bit Int overflow.
      ts: t.exposeFloat("ts"),
    }),
  });

/* ---- Per-app / per-database container metrics (the Monitoring TAB) ---- */

const ContainerInstanceMetricsRef = builder
  .objectRef<ContainerInstanceMetrics>("ContainerInstanceMetrics")
  .implement({
    description:
      "Live resource usage for ONE container of an app/database stack — the " +
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
    }),
  });

const ContainerMetricsSampleRef = builder
  .objectRef<ContainerMetricsSample>("ContainerMetricsSample")
  .implement({
    description:
      "One buffered aggregate metrics sample for an app/database stack (the sum " +
      "across its running containers) — what the Monitoring tab's charts seed " +
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
    }),
  });

const ContainerMetricsRef = builder
  .objectRef<ContainerMetrics>("ContainerMetrics")
  .implement({
    description:
      "A fresh live metrics snapshot for one app/database stack: the aggregate " +
      "across its containers, plus the per-container breakdown and an " +
      "`unsupported` flag (the owning server's agent is too old for per-container " +
      "metrics — the tab shows 'update the agent').",
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
      instances: t.field({
        type: [ContainerInstanceMetricsRef],
        description: "Per-container usage (multi-container stacks). Live only.",
        resolve: (m) => m.instances,
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
/* Queries (the polling actions — serverMetrics + allServerMetrics)    */
/* ------------------------------------------------------------------ */

builder.queryFields((t) => ({
  serverMetrics: t.field({
    type: ServerMetricsRef,
    authScopes: { loggedIn: true },
    description: "A fresh live metrics snapshot for one server.",
    args: { serverId: t.arg.string({ required: true }) },
    resolve: (_r, { serverId }) => getServerMetrics(serverId),
  }),
  allServerMetrics: t.field({
    type: [ServerMetricsRef],
    authScopes: { loggedIn: true },
    description: "Fresh live metrics snapshots for every server.",
    resolve: () => getAllServerMetrics(),
  }),
  serverMetricsHistory: t.field({
    type: [ServerMetricsRef],
    authScopes: { loggedIn: true },
    description:
      "The metrics history buffered on the control plane for one server (oldest " +
      "first) — what the Monitoring charts seed from on load. Empty when saving " +
      "is off or the control plane restarted recently.",
    args: { serverId: t.arg.string({ required: true }) },
    resolve: (_r, { serverId }) => getServerMetricsHistory(serverId),
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
    authScopes: { loggedIn: true },
    description: "A fresh live per-container metrics snapshot for one app.",
    args: { appId: t.arg.string({ required: true }) },
    resolve: (_r, { appId }) => getAppMetrics(appId),
  }),
  appMetricsHistory: t.field({
    type: [ContainerMetricsSampleRef],
    authScopes: { loggedIn: true },
    description:
      "The metrics history buffered for one app (oldest first) — what the app's " +
      "Monitoring charts seed from. Empty unless the app's Save-metrics switch is on.",
    args: { appId: t.arg.string({ required: true }) },
    resolve: (_r, { appId }) => getAppMetricsHistory(appId),
  }),
  databaseMetrics: t.field({
    type: ContainerMetricsRef,
    nullable: true,
    authScopes: { loggedIn: true },
    description: "A fresh live per-container metrics snapshot for one database.",
    args: { databaseId: t.arg.string({ required: true }) },
    resolve: (_r, { databaseId }) => getDatabaseMetrics(databaseId),
  }),
  databaseMetricsHistory: t.field({
    type: [ContainerMetricsSampleRef],
    authScopes: { loggedIn: true },
    description:
      "The metrics history buffered for one database (oldest first). Empty unless " +
      "the database's Save-metrics switch is on.",
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
    authScopes: { capability: "manage_infra" },
    description:
      "Turn saving server metrics on the control plane on or off. Turning it " +
      "off also drops the buffered history.",
    args: { enabled: t.arg.boolean({ required: true }) },
    resolve: (_r, { enabled }) => setSaveMetrics(enabled),
  }),

  // Per-app / per-database "Save metrics" switch (default OFF). `manage_infra`,
  // the same gate as the fleet toggle; enforced again in the data layer. Turning
  // it off drops that resource's buffered history. Returns the new value.
  setAppSaveMetrics: t.field({
    type: "Boolean",
    authScopes: { capability: "manage_infra" },
    description:
      "Turn saving THIS app's metrics history on or off. Off also drops its " +
      "buffered history.",
    args: {
      appId: t.arg.string({ required: true }),
      enabled: t.arg.boolean({ required: true }),
    },
    resolve: async (_r, { appId, enabled }) =>
      (await setAppSaveMetrics(appId, enabled)).saveMetrics,
  }),
  setDatabaseSaveMetrics: t.field({
    type: "Boolean",
    authScopes: { capability: "manage_infra" },
    description:
      "Turn saving THIS database's metrics history on or off. Off also drops its " +
      "buffered history.",
    args: {
      databaseId: t.arg.string({ required: true }),
      enabled: t.arg.boolean({ required: true }),
    },
    resolve: async (_r, { databaseId, enabled }) =>
      (await setDatabaseSaveMetrics(databaseId, enabled)).saveMetrics,
  }),
}));
