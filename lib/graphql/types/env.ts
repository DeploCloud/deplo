import { builder } from "../builder";
import { DatabaseTypeEnum, EnvTargetEnum } from "./enums";
import {
  listEnv,
  listAllAppEnv,
  upsertEnv,
  renameEnv,
  importEnv,
  setAppEnv,
  deleteEnv,
  makeEnvSecret,
  type AppEnvGroup,
} from "@/lib/data/env";
import { unlinkEnv } from "@/lib/data/database-links";
import type { AutoLink } from "@/lib/data/database-autolink";
import { dismissPendingChanges } from "@/lib/data/pending-changes";
import type { EnvDatabaseRef, EnvVarDTO } from "@/lib/types/env";
import type { VarAuthor } from "@/lib/types/identity";

export const EnvVarTypeEnum = builder.enumType("EnvVarType", {
  values: ["plain", "secret"] as const,
});

export const VarAuthorRef = builder
  .objectRef<VarAuthor>("VarAuthor")
  .implement({
    description:
      "The user who created or last modified a variable. Identity only, never an email.",
    fields: (t) => ({
      id: t.exposeID("id"),
      name: t.exposeString("name"),
      username: t.exposeString("username"),
      avatarColor: t.exposeString("avatarColor"),
      avatarUrl: t.exposeString("avatarUrl", {
        nullable: true,
        description:
          "Resolved profile picture: uploaded image, else Gravatar, else null for the monogram. Derived server-side, so the address itself never travels.",
      }),
    }),
  });

const EnvDatabaseRefRef = builder
  .objectRef<EnvDatabaseRef>("EnvDatabaseRef")
  .implement({
    description: "The managed database a variable's value comes from.",
    fields: (t) => ({
      id: t.exposeID("id"),
      name: t.exposeString("name"),
      type: t.field({ type: DatabaseTypeEnum, resolve: (d) => d.type }),
      reachable: t.exposeBoolean("reachable"),
    }),
  });

const EnvAutoLinkRef = builder.objectRef<AutoLink>("EnvAutoLink").implement({
  description:
    "A variable Deplo connected because its value is a database's connection string.",
  fields: (t) => ({
    key: t.exposeString("key"),
    database: t.exposeString("database"),
  }),
});

const EnvVarRef = builder.objectRef<EnvVarDTO>("EnvVar").implement({
  description:
    "A single environment variable. Secret values are masked unless revealed.",
  fields: (t) => ({
    id: t.exposeID("id"),
    key: t.exposeString("key"),
    value: t.exposeString("value"),
    isMasked: t.exposeBoolean("masked"),
    targets: t.field({
      type: [EnvTargetEnum],
      resolve: (e) => e.targets,
    }),
    type: t.field({ type: EnvVarTypeEnum, resolve: (e) => e.type }),
    connected: t.exposeBoolean("connected", {
      description:
        "The value comes from a managed database and is derived again at every deploy.",
    }),
    database: t.field({
      type: EnvDatabaseRefRef,
      nullable: true,
      description:
        "The connected database; null when not connected or the viewer cannot see databases.",
      resolve: (e) => e.database,
    }),
    createdBy: t.field({
      type: VarAuthorRef,
      nullable: true,
      resolve: (e) => e.createdBy,
    }),
    updatedBy: t.field({
      type: VarAuthorRef,
      nullable: true,
      resolve: (e) => e.updatedBy,
    }),
    createdAt: t.exposeString("createdAt"),
    updatedAt: t.exposeString("updatedAt"),
  }),
});

type AppEnvGroupApp = AppEnvGroup["app"];

const AppEnvGroupAppRef = builder
  .objectRef<AppEnvGroupApp>("AppEnvGroupApp")
  .implement({
    fields: (t) => ({
      id: t.exposeID("id"),
      name: t.exposeString("name"),
      slug: t.exposeString("slug"),
    }),
  });

const AppEnvGroupRef = builder.objectRef<AppEnvGroup>("AppEnvGroup").implement({
  description: "One app together with all of its env vars.",
  fields: (t) => ({
    app: t.field({
      type: AppEnvGroupAppRef,
      resolve: (g) => g.app,
    }),
    vars: t.field({
      type: [EnvVarRef],
      resolve: (g) => g.vars,
    }),
  }),
});

const EnvImportResultRef = builder
  .objectRef<{
    added: number;
    skippedSecrets: number;
    autoLinked: AutoLink[];
  }>("EnvImportResult")
  .implement({
    description:
      "What a .env import wrote, and what it deliberately left alone.",
    fields: (t) => ({
      added: t.exposeInt("added", {
        description: "Variables created or updated.",
      }),
      skippedSecrets: t.exposeInt("skippedSecrets", {
        description:
          "Lines whose key already exists as a secret. A secret cannot be edited, so those were left untouched.",
      }),
      autoLinked: t.field({
        type: [EnvAutoLinkRef],
        description:
          "Lines whose value is a database's connection string, now connected to it.",
        resolve: (r) => r.autoLinked,
      }),
    }),
  });

const UpsertEnvInputType = builder.inputType("UpsertEnvInput", {
  fields: (t) => ({
    appId: t.string({ required: true }),
    key: t.string({ required: true }),
    value: t.string({ required: true }),
    targets: t.field({ type: [EnvTargetEnum], required: false }),
    type: t.field({ type: EnvVarTypeEnum, required: true }),
  }),
});

const EnvEntryInputType = builder.inputType("EnvEntryInput", {
  fields: (t) => ({
    key: t.string({ required: true }),
    value: t.string({ required: true }),
  }),
});

builder.queryFields((t) => ({
  env: t.field({
    type: [EnvVarRef],
    authScopes: { loggedIn: true },
    description: "Env vars of a single project (requires manage_env).",
    args: { appId: t.arg.string({ required: true }) },
    resolve: (_r, { appId }) => listEnv(appId),
  }),
  allAppEnv: t.field({
    type: [AppEnvGroupRef],
    authScopes: { loggedIn: true },
    description: "Every app's env vars in the active team, grouped by project.",
    resolve: () => listAllAppEnv(),
  }),
}));

builder.mutationFields((t) => ({
  makeEnvSecret: t.field({
    type: "Boolean",
    authScopes: { capability: "manage_env" },
    description:
      "Make a variable Secret without changing its stored value or scope.",
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      await makeEnvSecret(id);
      return true;
    },
  }),
  upsertEnv: t.field({
    type: EnvVarRef,
    authScopes: { capability: "manage_env" },
    description: "Create or update an env var, then return the stored entity.",
    args: { input: t.arg({ type: UpsertEnvInputType, required: true }) },
    resolve: async (_r, { input }) => {
      await upsertEnv({
        appId: input.appId,
        key: input.key,
        value: input.value,
        targets: input.targets ?? undefined,
        type: input.type,
      });
      return reloadEnv(input.appId, input.key);
    },
  }),
  renameEnv: t.field({
    type: EnvVarRef,
    authScopes: { capability: "manage_env" },
    description:
      "Rename an env var's key in place, then return the stored entity.",
    args: {
      id: t.arg.string({ required: true }),
      newKey: t.arg.string({ required: true }),
    },
    resolve: async (_r, { id, newKey }) => {
      const appId = await renameEnv(id, newKey);
      return reloadEnv(appId, newKey);
    },
  }),
  dismissPendingChanges: t.field({
    type: "Boolean",
    authScopes: { capability: "manage_env" },
    description:
      'Clear this app\'s "changes not deployed yet" notice without deploying - ' +
      "the change was undone, or it was never one a deploy has to carry. " +
      "The next config change stamps it again.",
    args: { appId: t.arg.string({ required: true }) },
    resolve: async (_r, { appId }) => {
      await dismissPendingChanges(appId);
      return true;
    },
  }),
  unlinkEnv: t.field({
    type: EnvVarRef,
    authScopes: { capability: "manage_env" },
    description:
      "Stop a variable following its database. It keeps the value it resolves to now, and Deplo never connects it again on its own.",
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      const appId = await unlinkEnv(id);
      const found = (await listEnv(appId)).find((e) => e.id === id);
      if (!found) throw new Error("Env var not found");
      return found;
    },
  }),
  deleteEnv: t.field({
    type: "Boolean",
    authScopes: { capability: "manage_env" },
    description: "Delete an env var. Returns true.",
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      await deleteEnv(id);
      return true;
    },
  }),
  importEnv: t.field({
    type: EnvImportResultRef,
    authScopes: { capability: "manage_env" },
    description:
      "Bulk-import a .env-style blob. Every line lands as plain, so a key that already exists as a secret is skipped rather than downgraded.",
    args: {
      appId: t.arg.string({ required: true }),
      blob: t.arg.string({ required: true }),
      targets: t.arg({ type: [EnvTargetEnum], required: false }),
    },
    resolve: (_r, { appId, blob, targets }) =>
      importEnv(appId, blob, targets ?? undefined),
  }),
  setAppEnv: t.field({
    type: "Int",
    authScopes: { capability: "manage_env" },
    description:
      "Replace an app's whole env set from the .env editor (upsert the given entries, delete the rest). New vars default to plain; existing secrets are left untouched. Returns the resulting variable count.",
    args: {
      appId: t.arg.string({ required: true }),
      entries: t.arg({ type: [EnvEntryInputType], required: true }),
      defaultTargets: t.arg({ type: [EnvTargetEnum], required: false }),
    },
    resolve: (_r, { appId, entries, defaultTargets }) =>
      setAppEnv(
        appId,
        entries.map((e) => ({ key: e.key, value: e.value })),
        defaultTargets ?? undefined,
      ),
  }),
}));

async function reloadEnv(appId: string, key: string): Promise<EnvVarDTO> {
  const all = await listEnv(appId);
  const found = all.find((e) => e.key === key.trim());
  if (!found) throw new Error("Env var not found");
  return found;
}
