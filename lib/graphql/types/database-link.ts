import { builder } from "../builder";
import { DatabaseTypeEnum } from "./enums";
import {
  connectDatabase,
  disconnectDatabase,
  listDatabaseAppLinks,
  listDatabaseLinkOptionsForApp,
  type AppLinkOption,
  type DatabaseAppLink,
  type DatabaseLinkOption,
} from "@/lib/data/database-links";

const DatabaseReachEnum = builder.enumType("DatabaseReach", {
  description:
    "How an app would reach a database: on its private network, through the " +
    "database's public address, or not at all (and why).",
  values: {
    internal: { value: "internal" },
    public: { value: "public" },
    other_environment: { value: "other-environment" },
    other_server: { value: "other-server" },
    other_team: { value: "other-team" },
  } as const,
});

const DatabaseLinkOptionRef = builder
  .objectRef<DatabaseLinkOption>("DatabaseLinkOption")
  .implement({
    description:
      "A team database seen from one app, with whether it can be connected.",
    fields: (t) => ({
      id: t.exposeID("id"),
      name: t.exposeString("name"),
      type: t.field({ type: DatabaseTypeEnum, resolve: (d) => d.type }),
      logo: t.exposeString("logo", { nullable: true }),
      place: t.exposeString("place"),
      reach: t.field({ type: DatabaseReachEnum, resolve: (d) => d.reach }),
      connectedKeys: t.exposeStringList("connectedKeys", {
        description: "This app's variables already connected to it.",
      }),
    }),
  });

const AppLinkOptionRef = builder
  .objectRef<AppLinkOption>("AppLinkOption")
  .implement({
    description: "An app the viewer may connect a database to.",
    fields: (t) => ({
      id: t.exposeID("id"),
      name: t.exposeString("name"),
      slug: t.exposeString("slug"),
      logo: t.exposeString("logo", { nullable: true }),
      place: t.exposeString("place"),
      reach: t.field({ type: DatabaseReachEnum, resolve: (a) => a.reach }),
    }),
  });

const DatabaseAppLinkRef = builder
  .objectRef<DatabaseAppLink>("DatabaseAppLink")
  .implement({
    description: "A variable of an app whose value comes from this database.",
    fields: (t) => ({
      appId: t.exposeID("appId"),
      appName: t.exposeString("appName"),
      appSlug: t.exposeString("appSlug"),
      key: t.exposeString("key", {
        description: "Empty without manage_env on the app.",
      }),
      canManage: t.exposeBoolean("canManage"),
      reach: t.field({ type: DatabaseReachEnum, resolve: (l) => l.reach }),
    }),
  });

const DatabaseAppLinksRef = builder
  .objectRef<{ links: DatabaseAppLink[]; apps: AppLinkOption[] }>(
    "DatabaseAppLinks",
  )
  .implement({
    fields: (t) => ({
      links: t.field({ type: [DatabaseAppLinkRef], resolve: (r) => r.links }),
      apps: t.field({
        type: [AppLinkOptionRef],
        description: "Apps the viewer may connect it to.",
        resolve: (r) => r.apps,
      }),
    }),
  });

builder.queryFields((t) => ({
  appDatabaseOptions: t.field({
    type: [DatabaseLinkOptionRef],
    authScopes: { capability: "manage_env" },
    description:
      "The team's databases seen from one app, reachable ones first. Empty " +
      "without manage_env on the app or a role that reaches the whole team.",
    args: { appId: t.arg.string({ required: true }) },
    resolve: (_r, { appId }) => listDatabaseLinkOptionsForApp(appId),
  }),
  databaseAppLinks: t.field({
    type: DatabaseAppLinksRef,
    nullable: true,
    authScopes: { loggedIn: true },
    description:
      "Which apps a database is connected to, and which it could be.",
    args: { databaseId: t.arg.string({ required: true }) },
    resolve: (_r, { databaseId }) => listDatabaseAppLinks(databaseId),
  }),
}));

builder.mutationFields((t) => ({
  connectDatabase: t.field({
    type: "Boolean",
    authScopes: { capability: "manage_env" },
    description:
      "Give an app a variable whose value is this database's connection string, " +
      "derived again at every deploy so a password change follows on its own. " +
      "Replaces a variable of that name. Production only. Needs manage_env and " +
      "reveal_secrets on the app; refused when the app cannot reach the database.",
    args: {
      appId: t.arg.string({ required: true }),
      databaseId: t.arg.string({ required: true }),
      key: t.arg.string({ required: true }),
    },
    resolve: async (_r, args) => {
      await connectDatabase(args);
      return true;
    },
  }),
  disconnectDatabase: t.field({
    type: "Boolean",
    authScopes: { capability: "manage_env" },
    description:
      "Stop every variable of the app that comes from this database following it. " +
      "They keep the value they resolve to now.",
    args: {
      appId: t.arg.string({ required: true }),
      databaseId: t.arg.string({ required: true }),
    },
    resolve: async (_r, args) => {
      await disconnectDatabase(args);
      return true;
    },
  }),
}));
