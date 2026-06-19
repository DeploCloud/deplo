import { builder } from "../builder";
import {
  getServerMetrics,
  getAllServerMetrics,
  type ServerMetrics,
} from "@/lib/data/monitoring";

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
      // Epoch milliseconds; expose as Float to avoid 32-bit Int overflow.
      ts: t.exposeFloat("ts"),
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
}));

/* ------------------------------------------------------------------ */
/* No mutations — monitoring is read-only.                             */
/* ------------------------------------------------------------------ */
