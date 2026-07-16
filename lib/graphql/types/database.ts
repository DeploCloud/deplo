import { builder } from "../builder";
import { DatabaseTypeEnum } from "./enums";
import { ResourceLimitsRef, ResourceLimitsInputType } from "./resource-limits";
import { pubSub } from "../pubsub";
import {
  listDatabases,
  getDatabase,
  getDatabaseForTeam,
  getConnectionString,
  createDatabase,
  updateDatabase,
  reorderDatabases,
  updateDatabaseResources,
  updateDatabaseImage,
  setDatabaseRunning,
  restartDatabase,
  redeployDatabase,
  rotateDatabasePassword,
  deleteDatabase,
  generateAvailableDbPort,
  type DatabaseDTO,
} from "@/lib/data/databases";
import type { ResourceLimitsInput } from "@/lib/data/apps";

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
      resources: t.field({
        type: ResourceLimitsRef,
        nullable: true,
        description:
          "Per-database resource caps applied at provision/redeploy time, or " +
          "null when no limits are set.",
        resolve: (d) => d.resources,
      }),
      customImage: t.exposeString("customImage", {
        nullable: true,
        description:
          "Expert override: the full image ref replacing the derived engine " +
          "image; the version field is inert while set.",
      }),
      customCommand: t.exposeString("customCommand", {
        nullable: true,
        description:
          "Expert override: replaces the container command verbatim (redis's " +
          "default command carries --requirepass — omit it and auth is off).",
      }),
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

// Expert overrides (Settings → Advanced). Absent field = leave unchanged;
// explicit null = clear back to the derived/default value. Applied on the next
// redeploy or settings-driven reroute — the row is truth, the container follows.
const UpdateDatabaseImageInputType = builder.inputType("UpdateDatabaseImageInput", {
  fields: (t) => ({
    customImage: t.string({ required: false }),
    customCommand: t.string({ required: false }),
    version: t.string({ required: false }),
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
  restartDatabase: t.field({
    type: DatabaseRef,
    authScopes: { capability: "manage_infra" },
    description:
      "Restart the database container (stop + start) without re-rendering its " +
      "compose. Use redeployDatabase to apply pending settings.",
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      await restartDatabase(id);
      return reloadDatabase(id);
    },
  }),
  redeployDatabase: t.field({
    type: DatabaseRef,
    authScopes: { capability: "manage_infra" },
    description:
      "Re-render the database's compose from its current settings (resource " +
      "limits, image/command overrides, exposure) and reroute it on its server. " +
      "The container is recreated only when its config actually changed; the " +
      "data volume is always preserved.",
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      await redeployDatabase(id);
      return reloadDatabase(id);
    },
  }),
  updateDatabaseResources: t.field({
    type: DatabaseRef,
    authScopes: { capability: "manage_infra" },
    description:
      "Save the database's per-container resource limits. Applied on the next " +
      "redeploy or settings-driven reroute.",
    args: {
      id: t.arg.string({ required: true }),
      limits: t.arg({ type: ResourceLimitsInputType, required: true }),
    },
    resolve: async (_r, { id, limits }) => {
      await updateDatabaseResources(id, limits as ResourceLimitsInput);
      return reloadDatabase(id);
    },
  }),
  updateDatabaseImage: t.field({
    type: DatabaseRef,
    authScopes: { capability: "manage_infra" },
    description:
      "Save the database's expert overrides: custom image, custom command, " +
      "and/or engine version (image tag). Applied on the next redeploy. An " +
      "absent field is left unchanged; an explicit null clears the override.",
    args: {
      id: t.arg.string({ required: true }),
      input: t.arg({ type: UpdateDatabaseImageInputType, required: true }),
    },
    resolve: async (_r, { id, input }) => {
      await updateDatabaseImage(id, {
        customImage: input.customImage,
        customCommand: input.customCommand,
        version: input.version ?? undefined,
      });
      return reloadDatabase(id);
    },
  }),
  rotateDatabasePassword: t.field({
    type: "String",
    authScopes: { capability: "manage_infra" },
    description:
      "Rotate the database's engine password (auto-generated when none is " +
      "given) and return the NEW connection string — shown once, like " +
      "revealConnection. Engines that persist users in the data volume are " +
      "told first via an exec in the running container; the compose is then " +
      "re-rendered so env/command/healthcheck agree. Requires the database to " +
      "be running.",
    args: {
      id: t.arg.string({ required: true }),
      password: t.arg.string({ required: false }),
    },
    resolve: (_r, { id, password }) =>
      rotateDatabasePassword(id, { password: password ?? undefined }),
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
  reorderDatabases: t.field({
    type: "Boolean",
    authScopes: { capability: "manage_infra" },
    description:
      "Persist the team-wide order of databases in the Storage grid. Ids are " +
      "sanitised to the team's own databases; omitted ones are appended. " +
      "Returns true.",
    args: { databaseIds: t.arg.idList({ required: true }) },
    resolve: async (_r, { databaseIds }) => {
      await reorderDatabases(databaseIds.map(String));
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

/* ------------------------------------------------------------------ */
/* Subscriptions                                                       */
/* ------------------------------------------------------------------ */

builder.subscriptionFields((t) => ({
  databaseStatus: t.field({
    type: DatabaseRef,
    description:
      "Emits the database whenever its status changes (provisioning → running, " +
      "start/stop, redeploy, …). Fires once immediately with the current " +
      "snapshot, then on every change; ends when the database is deleted.",
    // Same gating as appStatus: `loggedIn` opens the stream, the generator
    // enforces team ownership through the cookie-free seam.
    authScopes: { loggedIn: true },
    args: { id: t.arg.string({ required: true }) },
    subscribe: (_root, { id }, ctx) => databaseStatusStream(id, ctx.teamId),
    resolve: (db) => db,
  }),
}));

// Exported for the SSE test (same contract as appStatusStream): it must stay
// cookie-free across iteration ticks — a subscription's async iterator runs
// AFTER the HTTP handler returned the streaming Response, so `cookies()` is no
// longer callable. Team identity rides in from the GraphQL context.
export async function* databaseStatusStream(
  id: string,
  teamId: string | null,
): AsyncGenerator<DatabaseDTO> {
  if (!teamId) throw new Error("Database not found");
  const first = await getDatabaseForTeam(id, teamId);
  if (!first) throw new Error("Database not found");

  // Initial snapshot — a fresh subscriber paints current state immediately.
  yield first;

  // Forward each change ping as a freshly-reloaded snapshot. A deleted database
  // reloads to null → end the stream.
  for await (const changedId of pubSub.subscribe("databaseChanged", id)) {
    const next = await getDatabaseForTeam(changedId, teamId);
    if (!next) return;
    yield next;
  }
}
