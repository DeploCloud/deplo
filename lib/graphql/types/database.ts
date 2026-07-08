import { builder } from "../builder";
import { DatabaseTypeEnum } from "./enums";
import {
  listDatabases,
  getDatabase,
  getConnectionString,
  createDatabase,
  updateDatabase,
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
      // The engine login + logical DB, shown read-only in the edit dialog (both
      // are create-only). The password is NEVER a field — reveal it only via the
      // revealConnection mutation.
      username: t.exposeString("username"),
      dbName: t.exposeString("dbName"),
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
    // Optional custom credentials, applied ONLY at first init against an empty
    // volume (the images honor POSTGRES_USER/DB, MYSQL_DATABASE, etc. only on
    // first boot), so they are create-only / display-only thereafter. Omitted =>
    // the auto-generated defaults (user "app"/"default", db = service name,
    // random password). `password` is INPUT-ONLY: it rides into the encrypted
    // connection string and is never echoed on any field (reveal it via
    // revealConnection).
    username: t.string({ required: false }),
    dbName: t.string({ required: false }),
    password: t.string({ required: false }),
    exposedPublicly: t.boolean({ required: false }),
    // The host port to publish on when exposedPublicly is true. Required by the
    // data layer in that case (validated + agent-checked for availability there).
    exposedPort: t.int({ required: false }),
  }),
});

// Exposure + server location are editable post-create. engine/version/username/
// dbName/password are create-only (the images apply those env vars only on first
// init against an empty volume — changing them is a silent no-op or data loss), so
// they are NOT in this input. Turning exposure ON requires exposedPort (the data
// layer validates + agent-checks it, exactly like createDatabase). serverId moves
// the database to another server — the container is recreated on the new host and
// its data volume is COPIED there host-to-host (relayed through the control plane,
// not via S3), so the data follows the move; omitted keeps it in place.
const UpdateDatabaseInputType = builder.inputType("UpdateDatabaseInput", {
  fields: (t) => ({
    exposedPublicly: t.boolean({ required: true }),
    exposedPort: t.int({ required: false }),
    serverId: t.id({ required: false }),
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
        username: input.username ?? undefined,
        dbName: input.dbName ?? undefined,
        password: input.password ?? undefined,
        exposedPublicly: input.exposedPublicly ?? undefined,
        exposedPort: input.exposedPort ?? undefined,
      }),
  }),
  updateDatabase: t.field({
    type: DatabaseRef,
    authScopes: { capability: "manage_infra" },
    description:
      "Edit a database's public exposure (publish/unpublish + host port) and, " +
      "optionally, the server it runs on. An in-place edit re-renders the compose " +
      "and reroutes the container on its current host (data volume preserved). A " +
      "server change recreates the container on the new host, COPIES its data " +
      "volume there host-to-host (relayed through the control plane, not via S3) so " +
      "the data follows the move, then tears down the old host's stack. The copy " +
      "runs with both stacks stopped and rolls back on failure (the DB stays put). " +
      "The connection string is re-derived. Everything else is create-only. The " +
      "publish-ports grant is enforced in the data layer when exposure is on.",
    args: {
      id: t.arg.string({ required: true }),
      input: t.arg({ type: UpdateDatabaseInputType, required: true }),
    },
    resolve: async (_r, { id, input }) => {
      await updateDatabase(id, {
        exposedPublicly: input.exposedPublicly,
        exposedPort: input.exposedPort ?? undefined,
        serverId: input.serverId ?? undefined,
      });
      return reloadDatabase(id);
    },
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
