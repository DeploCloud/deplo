import * as z from "zod";
import { appId, databaseId, page, tool, type McpToolDef } from "./tool-def";

const DATABASE_FIELDS = /* GraphQL */ `
  id
  name
  type
  version
  status
  host
  port
  dbName
  username
  serverId
  sizeMb
  exposedPublicly
  connectionStringMasked
`;

export const DATABASES: McpToolDef[] = [
  tool({
    name: "list_databases",
    title: "List databases",
    description:
      "Every managed database in this team, with status and size. Connection strings are masked.",
    group: "Databases",
    requires: "view",
    readOnly: true,
    idempotent: true,
    paginate: true,
    input: z.object({
      q: z
        .string()
        .optional()
        .describe(
          "Keep only databases whose name or id contains this. Omit for all of them.",
        ),
      ...page,
    }),
    query: /* GraphQL */ `
      query McpListDatabases($q: String) { databases(q: $q) { ${DATABASE_FIELDS} } }
    `,
  }),
  tool({
    name: "get_database",
    title: "Get a database",
    description: "One database in full, including its resource limits.",
    group: "Databases",
    requires: "view",
    readOnly: true,
    idempotent: true,
    input: z.object({ id: databaseId }),
    query: /* GraphQL */ `
      query McpGetDatabase($id: String!) {
        database(id: $id) {
          ${DATABASE_FIELDS}
          customImage
          customCommand
          resources { memoryMb cpuMilli pidsLimit storageGb }
        }
      }
    `,
  }),
  tool({
    name: "create_database",
    title: "Create a database",
    description:
      "Provision a managed Postgres, MySQL, MariaDB, MongoDB, Redis or ClickHouse.",
    group: "Databases",
    requires: "create_databases",
    input: z.object({
      name: z.string(),
      type: z.enum([
        "postgres",
        "mysql",
        "mariadb",
        "mongodb",
        "redis",
        "clickhouse",
      ]),
      version: z.string().describe('Engine version, e.g. "17".'),
      serverId: z.string().optional(),
      dbName: z.string().optional(),
      username: z.string().optional(),
    }),
    query: /* GraphQL */ `
      mutation McpCreateDatabase($input: CreateDatabaseInput!) {
        createDatabase(input: $input) { ${DATABASE_FIELDS} }
      }
    `,
    variables: (a) => ({ input: a }),
  }),
  tool({
    name: "control_database",
    title: "Start, stop or restart a database",
    description:
      "Bring a database's container up, down, or round again. Data is untouched either way; rebuild_database is the one that erases it.",
    group: "Databases",
    requires: "control_databases",
    idempotent: true,
    input: z.object({
      id: databaseId,
      action: z.enum(["start", "stop", "restart"]),
    }),
    variables: (a) => ({
      id: a.id,
      running: a.action === "start",
      isRunning: a.action !== "restart",
      isRestart: a.action === "restart",
    }),
    query: /* GraphQL */ `
      mutation McpControlDatabase(
        $id: String!
        $running: Boolean!
        $isRunning: Boolean!
        $isRestart: Boolean!
      ) {
        setDatabaseRunning(id: $id, running: $running) @include(if: $isRunning) { ${DATABASE_FIELDS} }
        restartDatabase(id: $id) @include(if: $isRestart) { ${DATABASE_FIELDS} }
      }
    `,
  }),
  tool({
    name: "redeploy_database",
    title: "Redeploy a database",
    description:
      "Re-render and restart the database from its current settings, keeping the data. This is the verb for applying a change; rebuild_database is not.",
    group: "Databases",
    requires: "control_databases",
    idempotent: true,
    input: z.object({ id: databaseId }),
    query: /* GraphQL */ `
      mutation McpRedeployDatabase($id: String!) {
        redeployDatabase(id: $id) { ${DATABASE_FIELDS} }
      }
    `,
  }),
  tool({
    name: "rebuild_database",
    title: "Rebuild a database (factory reset)",
    description:
      "WIPES the data volume and provisions the database again from scratch. Use redeploy or restart to preserve data.",
    group: "Databases",
    requires: "delete_databases",
    destructive: true,
    input: z.object({ id: databaseId }),
    query: /* GraphQL */ `
      mutation McpRebuildDatabase($id: String!) { rebuildDatabase(id: $id) { ${DATABASE_FIELDS} } }
    `,
  }),
  tool({
    name: "delete_database",
    title: "Delete a database",
    description:
      "Permanently delete the database, its container and its volume. Refuses unless the host confirms both are gone.",
    group: "Databases",
    requires: "delete_databases",
    destructive: true,
    input: z.object({ id: databaseId }),
    query: /* GraphQL */ `
      mutation McpDeleteDatabase($id: String!) {
        deleteDatabase(id: $id)
      }
    `,
  }),
  tool({
    name: "connect_database",
    title: "Connect a database to an app",
    description:
      "Give an app a production variable with the database's connection string, re-derived at every deploy. Replaces a variable of that name. Refused when the app cannot reach the database.",
    group: "Databases",
    requires: "manage_env",
    idempotent: true,
    input: z.object({
      appId,
      databaseId,
      key: z
        .string()
        .describe(
          "Variable name: DATABASE_URL for Postgres/MySQL/MariaDB, MONGODB_URI, REDIS_URL or CLICKHOUSE_URL by convention.",
        ),
    }),
    query: /* GraphQL */ `
      mutation McpConnectDatabase(
        $appId: String!
        $databaseId: String!
        $key: String!
      ) {
        connectDatabase(appId: $appId, databaseId: $databaseId, key: $key)
      }
    `,
  }),
  tool({
    name: "disconnect_database",
    title: "Disconnect a database from an app",
    description:
      "Delete the app's variables that come from this database. Takes effect on the next deploy.",
    group: "Databases",
    requires: "manage_env",
    destructive: true,
    input: z.object({ appId, databaseId }),
    query: /* GraphQL */ `
      mutation McpDisconnectDatabase($appId: String!, $databaseId: String!) {
        disconnectDatabase(appId: $appId, databaseId: $databaseId)
      }
    `,
  }),
];
