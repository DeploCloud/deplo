import * as z from "zod";
import { databaseId, serverId, tool, type McpToolDef } from "./tool-def";

const DATABASE_FIELDS_SETTINGS = /* GraphQL */ `
  id
  name
  type
  version
  status
  serverId
  environmentId
  exposedPublicly
  exposedPort
  customImage
  customCommand
  mounts {
    filePath
    mountPath
  }
`;

export const DATABASES_SETTINGS: McpToolDef[] = [
  tool({
    name: "update_database",
    title: "Expose a database or move it to another server",
    description:
      "Publish the database on a host port (exposedPublicly + exposedPort) or move it to another server, which copies its data.",
    group: "Databases",
    requires: "configure_databases",
    idempotent: true,
    input: z.object({
      databaseId,
      exposedPublicly: z.boolean(),
      exposedPort: z.number().int().optional(),
      serverId: z.string().optional().describe("Move it to this server."),
    }),
    variables: (a) => ({
      id: a.databaseId,
      input: {
        exposedPublicly: a.exposedPublicly,
        exposedPort: a.exposedPort,
        serverId: a.serverId,
      },
    }),
    query: /* GraphQL */ `
      mutation McpUpdateDatabase($id: String!, $input: UpdateDatabaseInput!) {
        updateDatabase(id: $id, input: $input) { ${DATABASE_FIELDS_SETTINGS} }
      }
    `,
  }),
  tool({
    name: "rename_database",
    title: "Rename a database",
    description: "Change a database's display name. Its host name stays.",
    group: "Databases",
    requires: "configure_databases",
    idempotent: true,
    input: z.object({ databaseId, name: z.string() }),
    variables: (a) => ({ id: a.databaseId, name: a.name }),
    query: /* GraphQL */ `
      mutation McpRenameDatabase($id: String!, $name: String!) {
        renameDatabase(id: $id, name: $name) { ${DATABASE_FIELDS_SETTINGS} }
      }
    `,
  }),
  tool({
    name: "set_database_resources",
    title: "Cap a database's CPU, memory or disk",
    description:
      "Resource limits applied on the next redeploy. Omit a field to leave it unlimited.",
    group: "Databases",
    requires: "configure_databases",
    idempotent: true,
    input: z.object({
      databaseId,
      memoryMb: z.number().int().optional(),
      cpuMilli: z.number().int().optional(),
      storageGb: z.number().int().optional(),
      pidsLimit: z.number().int().optional(),
    }),
    variables: (a) => ({
      id: a.databaseId,
      limits: {
        memoryMb: a.memoryMb,
        cpuMilli: a.cpuMilli,
        storageGb: a.storageGb,
        pidsLimit: a.pidsLimit,
      },
    }),
    query: /* GraphQL */ `
      mutation McpSetDatabaseResources(
        $id: String!
        $limits: ResourceLimitsInput!
      ) {
        updateDatabaseResources(id: $id, limits: $limits) { ${DATABASE_FIELDS_SETTINGS} }
      }
    `,
  }),
  tool({
    name: "set_database_config_files",
    title: "Set a database's config files",
    description:
      "Files Deplo writes and mounts into the database container, e.g. a postgresql.conf. The whole list at once; applied with a reroute.",
    group: "Databases",
    requires: "configure_databases",
    idempotent: true,
    destructive: true,
    input: z.object({
      databaseId,
      mounts: z.array(
        z.object({
          filePath: z.string().describe("Name of the file Deplo keeps."),
          mountPath: z.string().describe("Where it appears in the container."),
          content: z.string(),
        }),
      ),
    }),
    variables: (a) => ({ id: a.databaseId, mounts: a.mounts }),
    query: /* GraphQL */ `
      mutation McpSetDatabaseMounts(
        $id: String!
        $mounts: [DatabaseMountInput!]!
      ) {
        setDatabaseMounts(id: $id, mounts: $mounts) { ${DATABASE_FIELDS_SETTINGS} }
      }
    `,
  }),
  tool({
    name: "set_database_image",
    title: "Change a database's engine version or image",
    description:
      "Pin another engine version, or run a custom image/command. Applied on the next redeploy; a major-version jump may need a restore.",
    group: "Databases",
    requires: "configure_databases",
    idempotent: true,
    input: z.object({
      databaseId,
      version: z.string().optional(),
      customImage: z.string().optional(),
      customCommand: z.string().optional(),
    }),
    variables: (a) => ({
      id: a.databaseId,
      input: {
        version: a.version,
        customImage: a.customImage,
        customCommand: a.customCommand,
      },
    }),
    query: /* GraphQL */ `
      mutation McpSetDatabaseImage(
        $id: String!
        $input: UpdateDatabaseImageInput!
      ) {
        updateDatabaseImage(id: $id, input: $input) { ${DATABASE_FIELDS_SETTINGS} }
      }
    `,
  }),
  tool({
    name: "move_database",
    title: "Move a database into an environment",
    description:
      "Place a database in a project's environment (or null for the team top level), which decides the network it shares with apps.",
    group: "Databases",
    requires: "configure_databases",
    idempotent: true,
    input: z.object({
      databaseId,
      environmentId: z.string().nullable(),
    }),
    variables: (a) => ({ id: a.databaseId, environmentId: a.environmentId }),
    query: /* GraphQL */ `
      mutation McpMoveDatabase($id: String!, $environmentId: ID) {
        moveDatabaseToEnvironment(id: $id, environmentId: $environmentId)
      }
    `,
  }),
  tool({
    name: "check_host_ports",
    title: "Check whether host ports are free",
    description:
      "Ask a server which of these ports are already in use, before exposing a database or publishing an app port.",
    group: "Databases",
    requires: "create_databases",
    readOnly: true,
    idempotent: true,
    input: z.object({
      serverId,
      ports: z.array(z.number().int()).min(1),
    }),
    query: /* GraphQL */ `
      query McpHostPorts($serverId: ID!, $ports: [Int!]!) {
        hostPortsInUse(serverId: $serverId, ports: $ports) {
          checked
          inUse
          reason
        }
      }
    `,
  }),
];
