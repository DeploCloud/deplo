import { builder } from "../builder";
import {
  databaseTransferInfo,
  transferDatabaseToTeam,
  type DatabaseTransferInfo,
  type DatabaseTransferTarget,
} from "@/lib/data/databases/team-transfer";

const DatabaseTransferTargetRef = builder
  .objectRef<DatabaseTransferTarget>("DatabaseTransferTarget")
  .implement({
    description:
      "A team the viewer could hand this database to - one of their own other " +
      "teams where they hold move_databases.",
    fields: (t) => ({
      id: t.exposeID("id"),
      name: t.exposeString("name"),
      avatarUrl: t.exposeString("avatarUrl", { nullable: true }),
      serverAvailable: t.exposeBoolean("serverAvailable", {
        description:
          "False when the database's server is not shared with that team - the " +
          "transfer is refused until an instance admin grants access.",
      }),
      nameTaken: t.exposeBoolean("nameTaken", {
        description:
          "True when that team already has a database with this name - the " +
          "transfer is refused until one of them is renamed.",
      }),
    }),
  });

const DatabaseTransferInfoRef = builder
  .objectRef<DatabaseTransferInfo>("DatabaseTransferInfo")
  .implement({
    description:
      "What a transfer of this database would cost, plus the teams that could take it.",
    fields: (t) => ({
      databaseName: t.exposeString("databaseName"),
      serverName: t.exposeString("serverName"),
      environmentName: t.exposeString("environmentName", {
        nullable: true,
        description:
          "The Environment it sits in, or null at the top level. It lands at the " +
          "top level of the new team.",
      }),
      backupCount: t.exposeInt("backupCount", {
        description:
          "Backup schedules for this database - removed on transfer, because they " +
          "write to the current team's storage. Backups already taken stay.",
      }),
      cronCount: t.exposeInt("cronCount", {
        description: "Cron jobs for this database - removed on transfer.",
      }),
      usedBy: t.exposeStringList("usedBy", {
        description:
          "Apps of the current team whose variables or compose name this " +
          "database's host. They stop reaching it once it leaves.",
      }),
      running: t.exposeBoolean("running"),
      targets: t.field({
        type: [DatabaseTransferTargetRef],
        resolve: (x) => x.targets,
      }),
    }),
  });

builder.queryFields((t) => ({
  databaseTransferInfo: t.field({
    type: DatabaseTransferInfoRef,
    authScopes: { capability: "move_databases" },
    description:
      "What transferring this database to another team would change, and which " +
      "of the viewer's other teams could take it.",
    args: { id: t.arg.string({ required: true }) },
    resolve: (_r, { id }) => databaseTransferInfo(id),
  }),
}));

builder.mutationFields((t) => ({
  transferDatabaseToTeam: t.field({
    type: "Boolean",
    authScopes: { capability: "move_databases" },
    description:
      "Hand this database, with its data, to another team the viewer belongs to. " +
      "It lands at that team's top level and restarts on its network; backup " +
      "schedules and cron jobs are removed. Returns true.",
    args: {
      id: t.arg.string({ required: true }),
      teamId: t.arg.string({ required: true }),
    },
    resolve: async (_r, { id, teamId }) => {
      await transferDatabaseToTeam(id, teamId);
      return true;
    },
  }),
}));
