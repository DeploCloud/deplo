import { builder } from "../builder";
import { EnvTargetEnum } from "./enums";
import {
  listEnv,
  listAllAppEnv,
  revealEnv,
  upsertEnv,
  renameEnv,
  importEnv,
  setAppEnv,
  deleteEnv,
  type AppEnvGroup,
} from "@/lib/data/env";
import type { EnvVarDTO, VarAuthor } from "@/lib/types";

/* ------------------------------------------------------------------ */
/* Local enums                                                         */
/* ------------------------------------------------------------------ */

// `type` is a two-valued union that is not shared in enums.ts, so it lives here.
// Exported so the global-env types can reuse the same GraphQL enum (a Pothos enum
// name must be unique, so there can be only one "EnvVarType").
export const EnvVarTypeEnum = builder.enumType("EnvVarType", {
  values: ["plain", "secret"] as const,
});

/* ------------------------------------------------------------------ */
/* Object types                                                        */
/* ------------------------------------------------------------------ */

// The one authorship type for every kind of variable (app / instance / shared),
// so exported: a Pothos type name must be unique, and global-env.ts and
// shared-env.ts import this ref rather than declaring a second "VarAuthor".
export const VarAuthorRef = builder.objectRef<VarAuthor>("VarAuthor").implement({
  description:
    "The user who created or last modified a variable. Identity only — never an email.",
  fields: (t) => ({
    id: t.exposeID("id"),
    name: t.exposeString("name"),
    username: t.exposeString("username"),
    avatarColor: t.exposeString("avatarColor"),
  }),
});

const EnvVarRef = builder.objectRef<EnvVarDTO>("EnvVar").implement({
  description:
    "A single environment variable. Secret values are masked unless revealed.",
  fields: (t) => ({
    id: t.exposeID("id"),
    key: t.exposeString("key"),
    // Masked placeholder for secrets; reveal the real value via revealEnv().
    value: t.exposeString("value"),
    isMasked: t.exposeBoolean("masked"),
    targets: t.field({
      type: [EnvTargetEnum],
      resolve: (e) => e.targets,
    }),
    type: t.field({ type: EnvVarTypeEnum, resolve: (e) => e.type }),
    // Null for rows written before authorship tracking, or once the author's
    // user is deleted (the FK is ON DELETE SET NULL) — the UI renders "—".
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

// The lightweight project descriptor each group carries (id/name/slug only).
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

const AppEnvGroupRef = builder
  .objectRef<AppEnvGroup>("AppEnvGroup")
  .implement({
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

/* ------------------------------------------------------------------ */
/* Inputs                                                              */
/* ------------------------------------------------------------------ */

const UpsertEnvInputType = builder.inputType("UpsertEnvInput", {
  fields: (t) => ({
    appId: t.string({ required: true }),
    key: t.string({ required: true }),
    value: t.string({ required: true }),
    // An App belongs to exactly one Environment, so the UI no longer asks for
    // deploy runtimes; omit and the variable applies to all of them. Optional,
    // not removed, so clients still passing targets keep working.
    targets: t.field({ type: [EnvTargetEnum], required: false }),
    type: t.field({ type: EnvVarTypeEnum, required: true }),
  }),
});

// One KEY=VALUE pair for the ".env editor" (setAppEnv). `type`/`targets` are
// not expressed here: existing vars keep theirs, new ones default to plain.
const EnvEntryInputType = builder.inputType("EnvEntryInput", {
  fields: (t) => ({
    key: t.string({ required: true }),
    value: t.string({ required: true }),
  }),
});

/* ------------------------------------------------------------------ */
/* Queries                                                             */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/* Mutations (every env server action)                                 */
/* ------------------------------------------------------------------ */

builder.mutationFields((t) => ({
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
    description: "Rename an env var's key in place, then return the stored entity.",
    args: {
      id: t.arg.string({ required: true }),
      newKey: t.arg.string({ required: true }),
    },
    resolve: async (_r, { id, newKey }) => {
      const appId = await renameEnv(id, newKey);
      return reloadEnv(appId, newKey);
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
    type: "Int",
    authScopes: { capability: "manage_env" },
    description:
      "Bulk-import a .env-style blob; returns the number of vars imported.",
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
      "Replace an app's whole env set from the .env editor (upsert the given entries, delete the rest). New vars default to plain; unchanged secrets are preserved. Returns the resulting variable count.",
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
  revealEnv: t.field({
    type: "String",
    authScopes: { capability: "manage_env" },
    description: "Reveal a single secret's plaintext value.",
    args: { id: t.arg.string({ required: true }) },
    resolve: (_r, { id }) => revealEnv(id),
  }),
}));

/** Reload a single env var after the void upsert so we can return the entity. */
async function reloadEnv(appId: string, key: string): Promise<EnvVarDTO> {
  const all = await listEnv(appId);
  const found = all.find((e) => e.key === key.trim());
  if (!found) throw new Error("Env var not found");
  return found;
}
