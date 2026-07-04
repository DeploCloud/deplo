import { builder } from "../builder";
import { DatabaseTypeEnum } from "./enums";
import {
  listDatabases,
  getDatabase,
  getConnectionString,
  createDatabase,
  setDatabaseRunning,
  deleteDatabase,
  generateAvailableDbPort,
  type DatabaseDTO,
} from "@/lib/data/databases";

/* ------------------------------------------------------------------ */
/* Local enums (not in the shared enums.ts)                            */
/* ------------------------------------------------------------------ */

// DatabaseStatus is local to this domain — define it here rather than in the
// shared enums file. No hyphens, so the plain value list is fine.
const DatabaseStatusEnum = builder.enumType("DatabaseStatus", {
  values: ["running", "stopped", "provisioning", "error"] as const,
});

/* ------------------------------------------------------------------ */
/* Object types                                                        */
/* ------------------------------------------------------------------ */

export const DatabaseRef = builder
  .objectRef<DatabaseDTO>("Database")
  .implement({
    description:
      "A provisioned database container owned by a team. The connection " +
      "string is masked; reveal it with the revealConnection mutation.",
    fields: (t) => ({
      id: t.exposeID("id"),
      teamId: t.exposeID("teamId"),
      name: t.exposeString("name"),
      type: t.field({ type: DatabaseTypeEnum, resolve: (d) => d.type }),
      version: t.exposeString("version"),
      status: t.field({ type: DatabaseStatusEnum, resolve: (d) => d.status }),
      serverId: t.exposeID("serverId"),
      host: t.exposeString("host"),
      port: t.exposeInt("port"),
      connectionStringMasked: t.exposeString("connectionStringMasked"),
      exposedPublicly: t.exposeBoolean("exposedPublicly"),
      // The published host port when exposedPublicly is true; null otherwise.
      exposedPort: t.exposeInt("exposedPort", { nullable: true }),
      sizeMb: t.exposeInt("sizeMb"),
      createdAt: t.exposeString("createdAt"),
    }),
  });

/* ------------------------------------------------------------------ */
/* Inputs                                                              */
/* ------------------------------------------------------------------ */

const CreateDatabaseInputType = builder.inputType("CreateDatabaseInput", {
  fields: (t) => ({
    name: t.string({ required: true }),
    type: t.field({ type: DatabaseTypeEnum, required: true }),
    version: t.string({ required: true }),
    // The server to provision the database on. Optional: omitted defaults to the
    // sole server when there is exactly one (Step 0 — DB-on-agent).
    serverId: t.id({ required: false }),
    exposedPublicly: t.boolean({ required: false }),
    // The host port to publish on when exposedPublicly is true. Required by the
    // data layer in that case (validated + agent-checked for availability there).
    exposedPort: t.int({ required: false }),
  }),
});

/* ------------------------------------------------------------------ */
/* Queries                                                             */
/* ------------------------------------------------------------------ */

builder.queryFields((t) => ({
  databases: t.field({
    type: [DatabaseRef],
    authScopes: { loggedIn: true },
    description: "All databases in the active team, newest first.",
    resolve: () => listDatabases(),
  }),
  database: t.field({
    type: DatabaseRef,
    nullable: true,
    authScopes: { loggedIn: true },
    args: { id: t.arg.string({ required: true }) },
    resolve: (_r, { id }) => getDatabase(id),
  }),
}));

/* ------------------------------------------------------------------ */
/* Mutations (every database server action)                            */
/* ------------------------------------------------------------------ */

builder.mutationFields((t) => ({
  createDatabase: t.field({
    type: DatabaseRef,
    authScopes: { capability: "manage_infra" },
    args: { input: t.arg({ type: CreateDatabaseInputType, required: true }) },
    resolve: (_r, { input }) =>
      createDatabase({
        name: input.name,
        type: input.type,
        version: input.version,
        serverId: input.serverId ?? undefined,
        exposedPublicly: input.exposedPublicly ?? undefined,
        exposedPort: input.exposedPort ?? undefined,
      }),
  }),
  generateAvailableDbPort: t.field({
    type: "Int",
    authScopes: { capability: "manage_infra" },
    description:
      "Suggest a host port that is currently free on the target server, for the " +
      "database 'Expose publicly' flow. Requires the publish-ports grant.",
    args: { serverId: t.arg.id({ required: false }) },
    resolve: (_r, { serverId }) =>
      generateAvailableDbPort({ serverId: serverId ?? undefined }),
  }),
  setDatabaseRunning: t.field({
    type: DatabaseRef,
    authScopes: { capability: "manage_infra" },
    args: {
      id: t.arg.string({ required: true }),
      running: t.arg.boolean({ required: true }),
    },
    resolve: async (_r, { id, running }) => {
      await setDatabaseRunning(id, running);
      return reloadDatabase(id);
    },
  }),
  deleteDatabase: t.field({
    type: "Boolean",
    authScopes: { capability: "manage_infra" },
    description: "Tear down the database container + volume. Returns true.",
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      await deleteDatabase(id);
      return true;
    },
  }),
  revealConnection: t.field({
    type: "String",
    authScopes: { capability: "manage_infra" },
    description: "Reveal the full (unmasked) connection string for a database.",
    args: { id: t.arg.string({ required: true }) },
    resolve: (_r, { id }) => getConnectionString(id),
  }),
}));

/** Reload a database by id after a void mutation so we can return the entity. */
async function reloadDatabase(id: string): Promise<DatabaseDTO> {
  const db = await getDatabase(id);
  if (!db) throw new Error("Database not found");
  return db;
}
