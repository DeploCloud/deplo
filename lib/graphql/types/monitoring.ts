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
}));
