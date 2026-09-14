import * as z from "zod";
import { page, tool, type McpToolDef } from "./tool-def";

export const LOGS: McpToolDef[] = [
  tool({
    name: "logs",
    title: "Read logs",
    description:
      "The tail of an app's or a database's container output. Truncated to stay readable; ask for fewer lines if you only need the end.",
    group: "Logs",
    requires: "view_logs",
    readOnly: true,
    idempotent: true,
    input: z.object({
      kind: z.enum(["app", "database"]).describe("What the id names."),
      id: z.string().describe("The app's or database's id."),
      lines: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe("How many lines back (default 200)."),
      container: z
        .string()
        .optional()
        .describe(
          "One container, by compose service name; defaults to the workload's own.",
        ),
    }),
    query: "",
    run: async (a) => {
      const { appLogsSnapshot, databaseLogsSnapshot } =
        await import("../../data/logs-snapshot");
      const read = a.kind === "app" ? appLogsSnapshot : databaseLogsSnapshot;
      return read(a.id, { lines: a.lines, container: a.container });
    },
  }),
];

const CONTAINER_METRICS = /* GraphQL */ `
  id
  online
  cpu
  memUsed
  memLimit
  memPct
  netRx
  netTx
  pids
  running
  ts
`;

export const METRICS: McpToolDef[] = [
  tool({
    name: "metrics",
    title: "Live metrics",
    description:
      "Live CPU, memory and I/O for an app, a database or a whole server. A server also reports disk, which is how you explain a build that failed on a full host.",
    group: "Monitoring",
    requires: "view_metrics",
    readOnly: true,
    idempotent: true,
    input: z.object({
      kind: z
        .enum(["app", "database", "server"])
        .describe("What the id names."),
      id: z.string().describe("The app's, database's or server's id."),
    }),
    variables: (a) => ({
      id: a.id,
      isApp: a.kind === "app",
      isDatabase: a.kind === "database",
      isServer: a.kind === "server",
    }),
    query: /* GraphQL */ `
      query McpMetrics(
        $id: String!
        $isApp: Boolean!
        $isDatabase: Boolean!
        $isServer: Boolean!
      ) {
        appMetrics(appId: $id) @include(if: $isApp) {
          ${CONTAINER_METRICS}
          blockRead
          blockWrite
          containers
        }
        databaseMetrics(databaseId: $id) @include(if: $isDatabase) {
          ${CONTAINER_METRICS}
        }
        serverMetrics(serverId: $id) @include(if: $isServer) {
          serverId
          online
          cpu
          cpuCores
          memUsed
          memTotal
          memPct
          diskUsed
          diskTotal
          diskPct
          load
          containers
          uptimeSec
          ts
        }
      }
    `,
  }),
];

export const METRICS_HISTORY: McpToolDef[] = [
  tool({
    name: "metrics_history",
    title: "Read metrics history",
    description:
      "The recent CPU, memory, network and disk samples of an app, a database or a server, as the Monitoring page charts them.",
    group: "Monitoring",
    requires: "view_metrics",
    readOnly: true,
    idempotent: true,
    paginate: true,
    input: z.object({
      kind: z.enum(["app", "database", "server"]),
      id: z.string(),
      ...page,
    }),
    variables: (a) => ({
      id: a.id,
      app: a.kind === "app",
      database: a.kind === "database",
      server: a.kind === "server",
    }),
    query: /* GraphQL */ `
      query McpMetricsHistory(
        $id: String!
        $app: Boolean!
        $database: Boolean!
        $server: Boolean!
      ) {
        appMetricsHistory(appId: $id) @include(if: $app) {
          ts
          cpu
          memUsed
          memLimit
          memPct
          netRx
          netTx
          blockRead
          blockWrite
          pids
          running
        }
        databaseMetricsHistory(databaseId: $id) @include(if: $database) {
          ts
          cpu
          memUsed
          memLimit
          memPct
          netRx
          netTx
          blockRead
          blockWrite
          pids
          running
        }
        serverMetricsHistory(serverId: $id) @include(if: $server) {
          ts
          online
          cpu
          memPct
          memUsed
          memTotal
          diskPct
          diskUsed
          diskTotal
          load
          netRx
          netTx
          containers
        }
      }
    `,
  }),
  tool({
    name: "fleet_metrics",
    title: "Read the fleet's live metrics",
    description:
      "One line per server: online, CPU, memory, disk and container count, right now.",
    group: "Monitoring",
    requires: "view_metrics",
    readOnly: true,
    idempotent: true,
    input: z.object({}),
    query: /* GraphQL */ `
      query McpFleetMetrics {
        fleetMetrics {
          serverId
          online
          cpu
          memPct
          diskPct
          containers
          agentVersion
          expectedAgentVersion
          ts
        }
      }
    `,
  }),
  tool({
    name: "set_metrics_retention",
    title: "Turn metrics history on or off",
    description:
      "Whether the team keeps metrics history for its Monitoring charts.",
    group: "Monitoring",
    requires: "manage_monitoring",
    idempotent: true,
    input: z.object({ enabled: z.boolean() }),
    query: /* GraphQL */ `
      mutation McpSetSaveMetrics($enabled: Boolean!) {
        setSaveMetrics(enabled: $enabled) {
          saveMetrics
        }
      }
    `,
  }),
];
