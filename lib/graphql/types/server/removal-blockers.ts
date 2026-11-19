import { builder } from "../../builder";
import {
  moveOffServer,
  removeDestinationOffServer,
  serverRemovalBlockers,
  type RemovalDestination,
  type RemovalItem,
  type RemovalTarget,
  type ServerRemovalBlockers,
} from "@/lib/data/servers/removal-blockers";

const RemovalTargetRef = builder
  .objectRef<RemovalTarget>("ServerRemovalTarget")
  .implement({
    description: "A server something can move to.",
    fields: (t) => ({
      id: t.exposeID("id"),
      name: t.exposeString("name"),
    }),
  });

const RemovalItemRef = builder
  .objectRef<RemovalItem>("ServerRemovalItem")
  .implement({
    description:
      "An App, database or cluster leader that keeps a server from being removed until it moves.",
    fields: (t) => ({
      id: t.exposeID("id"),
      name: t.exposeString("name"),
      teamName: t.exposeString("teamName", {
        description: "The team it belongs to; empty for a cluster.",
      }),
      teamAvatarUrl: t.exposeString("teamAvatarUrl", { nullable: true }),
      logo: t.exposeString("logo", { nullable: true }),
      logoTone: t.exposeString("logoTone", { nullable: true }),
      engine: t.exposeString("engine", {
        nullable: true,
        description: 'A database\'s engine ("postgres"); null otherwise.',
      }),
      moveTo: t.field({
        type: [RemovalTargetRef],
        description:
          "Where it can go: servers its team can use, or for a cluster the servers its leader can run on. Empty when nowhere.",
        resolve: (i) => i.moveTo,
      }),
      note: t.exposeString("note", {
        description:
          "Why it cannot move from here right now (being deleted, still being created); empty when it can.",
      }),
    }),
  });

const RemovalDestinationRef = builder
  .objectRef<RemovalDestination>("ServerRemovalDestination")
  .implement({
    description: "A backup destination kept on a server being removed.",
    fields: (t) => ({
      id: t.exposeID("id"),
      name: t.exposeString("name"),
      teamName: t.exposeString("teamName"),
      teamAvatarUrl: t.exposeString("teamAvatarUrl", { nullable: true }),
      schedules: t.exposeInt("schedules", {
        description: "Backup schedules that go with it.",
      }),
      artifacts: t.exposeInt("artifacts", {
        description: "Backup files kept there.",
      }),
    }),
  });

const ServerRemovalBlockersRef = builder
  .objectRef<ServerRemovalBlockers>("ServerRemovalBlockers")
  .implement({
    description:
      "Everything that keeps a server from being removed, across every team. All lists empty means removeServer goes through.",
    fields: (t) => ({
      apps: t.field({ type: [RemovalItemRef], resolve: (b) => b.apps }),
      databases: t.field({
        type: [RemovalItemRef],
        resolve: (b) => b.databases,
      }),
      clusters: t.field({
        type: [RemovalItemRef],
        description: "Clusters whose leader runs on this server.",
        resolve: (b) => b.clusters,
      }),
      destinations: t.field({
        type: [RemovalDestinationRef],
        resolve: (b) => b.destinations,
      }),
      copying: t.exposeStringList("copying", {
        description:
          "Apps still copying their data off this server. Not a blocker: removing the server now leaves that data behind.",
      }),
      online: t.exposeBoolean("online", {
        description:
          "False while the server does not answer: the backup files of a destination kept there cannot be deleted then.",
      }),
    }),
  });

builder.queryFields((t) => ({
  serverRemovalBlockers: t.field({
    type: ServerRemovalBlockersRef,
    authScopes: { instanceAdmin: true },
    description:
      "What keeps this server from being removed, so it can be fixed before removeServer refuses. Instance admins only.",
    args: { id: t.arg.string({ required: true }) },
    resolve: (_r, { id }) => serverRemovalBlockers(id),
  }),
}));

builder.mutationFields((t) => ({
  moveOffServer: t.field({
    type: "Boolean",
    authScopes: { instanceAdmin: true },
    description:
      'Move one App or database (`kind`: "app" or "database") off a server being removed, to a server its team can use. It stays its team\'s, and the move is recorded in that team\'s Activity. Returns true.',
    args: {
      serverId: t.arg.string({ required: true }),
      kind: t.arg.string({ required: true }),
      id: t.arg.string({ required: true }),
      toServerId: t.arg.string({ required: true }),
    },
    resolve: async (_r, { serverId, kind, id, toServerId }) => {
      if (kind !== "app" && kind !== "database")
        throw new Error('kind is "app" or "database"');
      await moveOffServer(serverId, kind, id, toServerId);
      return true;
    },
  }),
  removeDestinationOffServer: t.field({
    type: "Boolean",
    authScopes: { instanceAdmin: true },
    description:
      "Remove a backup destination kept on a server being removed, with its schedules and restore points, for whichever team owns it. With `deleteArtifacts` the backup files go too. Returns true.",
    args: {
      serverId: t.arg.string({ required: true }),
      id: t.arg.string({ required: true }),
      deleteArtifacts: t.arg.boolean({ required: false }),
    },
    resolve: async (_r, { serverId, id, deleteArtifacts }) => {
      await removeDestinationOffServer(serverId, id, deleteArtifacts ?? false);
      return true;
    },
  }),
}));
