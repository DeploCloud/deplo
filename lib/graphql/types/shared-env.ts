import { builder } from "../builder";
import { EnvTargetEnum } from "./enums";
import { EnvVarTypeEnum } from "./env";
import {
  listSharedVars,
  listSharedVarsForApp,
  revealSharedVar,
  saveSharedVar,
  setSharedVarAppLink,
  deleteSharedVar,
  type SharedVarDTO,
  type AppSharedVarDTO,
} from "@/lib/data/shared-vars";

/* ------------------------------------------------------------------ */
/* Object types                                                        */
/* ------------------------------------------------------------------ */

/** A lightweight environment reference embedded in a shared var's scope. */
const SharedVarEnvironmentRef = builder
  .objectRef<SharedVarDTO["environments"][number]>("SharedVarEnvironment")
  .implement({
    fields: (t) => ({
      id: t.exposeID("id"),
      name: t.exposeString("name"),
      projectName: t.exposeString("projectName"),
    }),
  });

/** A lightweight project reference embedded in a shared var's scope. */
const SharedVarProjectRef = builder
  .objectRef<SharedVarDTO["projects"][number]>("SharedVarProject")
  .implement({
    fields: (t) => ({
      id: t.exposeID("id"),
      name: t.exposeString("name"),
      slug: t.exposeString("slug"),
    }),
  });

/** A lightweight app reference embedded in a shared var's per-app links. */
const SharedVarAppRef = builder
  .objectRef<SharedVarDTO["apps"][number]>("SharedVarApp")
  .implement({
    fields: (t) => ({
      id: t.exposeID("id"),
      name: t.exposeString("name"),
      slug: t.exposeString("slug"),
    }),
  });

/** One unified shared variable with its three sharing modes + per-app links. */
const SharedVarRef = builder.objectRef<SharedVarDTO>("SharedVar").implement({
  description:
    "A shared environment variable (ADR-0010). Secret values are masked. It " +
    "reaches apps via team-wide / environment / project modes plus per-app links.",
  fields: (t) => ({
    id: t.exposeID("id"),
    key: t.exposeString("key"),
    value: t.exposeString("value"),
    masked: t.exposeBoolean("masked"),
    type: t.field({ type: EnvVarTypeEnum, resolve: (v) => v.type }),
    targets: t.field({
      type: [EnvTargetEnum],
      description: "Deploy runtimes this variable applies to.",
      resolve: (v) => v.targets,
    }),
    teamWide: t.exposeBoolean("teamWide"),
    environmentIds: t.exposeIDList("environmentIds"),
    projectIds: t.exposeIDList("projectIds"),
    appIds: t.exposeIDList("appIds"),
    environments: t.field({
      type: [SharedVarEnvironmentRef],
      resolve: (v) => v.environments,
    }),
    projects: t.field({
      type: [SharedVarProjectRef],
      resolve: (v) => v.projects,
    }),
    apps: t.field({ type: [SharedVarAppRef], resolve: (v) => v.apps }),
    updatedAt: t.exposeString("updatedAt"),
  }),
});

/** A shared var as seen from one app: does it apply, how, and its link state. */
const AppSharedVarRef = builder
  .objectRef<AppSharedVarDTO>("AppSharedVar")
  .implement({
    description:
      "A shared variable as seen from one app, with its per-app link state.",
    fields: (t) => ({
      id: t.exposeID("id"),
      key: t.exposeString("key"),
      masked: t.exposeBoolean("masked"),
      type: t.field({ type: EnvVarTypeEnum, resolve: (v) => v.type }),
      targets: t.field({ type: [EnvTargetEnum], resolve: (v) => v.targets }),
      via: t.exposeString("via", {
        description: "How it reaches this app: teamWide | environment | project | link.",
      }),
      applied: t.exposeBoolean("applied"),
      inherited: t.exposeBoolean("inherited"),
      linked: t.exposeBoolean("linked"),
    }),
  });

/* ------------------------------------------------------------------ */
/* Inputs                                                              */
/* ------------------------------------------------------------------ */

const SaveSharedVarInputType = builder.inputType("SaveSharedVarInput", {
  description:
    "Create (omit id) or update (provide id) one shared variable. At least one " +
    "sharing mode is required: teamWide, ≥1 environment, or ≥1 project.",
  fields: (t) => ({
    id: t.string({ required: false }),
    key: t.string({ required: true }),
    value: t.string({ required: true }),
    type: t.field({ type: EnvVarTypeEnum, required: true }),
    targets: t.field({ type: [EnvTargetEnum], required: true }),
    teamWide: t.boolean({ required: true }),
    environmentIds: t.idList({ required: true }),
    projectIds: t.idList({ required: true }),
  }),
});

/* ------------------------------------------------------------------ */
/* Queries                                                             */
/* ------------------------------------------------------------------ */

builder.queryFields((t) => ({
  sharedVars: t.field({
    type: [SharedVarRef],
    authScopes: { capability: "manage_env" },
    description: "All shared variables in the active team, A→Z.",
    resolve: () => listSharedVars(),
  }),
  sharedVarsForApp: t.field({
    type: [AppSharedVarRef],
    authScopes: { capability: "manage_env" },
    description:
      "Shared variables relevant to one app, with per-app link + applied state.",
    args: { appId: t.arg.string({ required: true }) },
    resolve: (_r, { appId }) => listSharedVarsForApp(appId),
  }),
}));

/* ------------------------------------------------------------------ */
/* Mutations                                                           */
/* ------------------------------------------------------------------ */

builder.mutationFields((t) => ({
  saveSharedVar: t.field({
    type: SharedVarRef,
    authScopes: { capability: "manage_env" },
    description: "Create or update a shared variable; returns the saved entity.",
    args: { input: t.arg({ type: SaveSharedVarInputType, required: true }) },
    resolve: async (_r, { input }) => {
      const id = await saveSharedVar({
        id: input.id ?? undefined,
        key: input.key,
        value: input.value,
        type: input.type,
        targets: input.targets,
        teamWide: input.teamWide,
        environmentIds: input.environmentIds,
        projectIds: input.projectIds,
      });
      // Reload by the id the data fn minted — matching by key would be ambiguous
      // (keys are deliberately NOT unique per team; a key repeats across scopes).
      const saved = (await listSharedVars()).find((v) => v.id === id);
      if (!saved) throw new Error("Shared variable not found");
      return saved;
    },
  }),
  setSharedVarAppLink: t.field({
    type: "Boolean",
    authScopes: { capability: "manage_env" },
    description: "Link or unlink a shared variable to one app. Returns true.",
    args: {
      varId: t.arg.string({ required: true }),
      appId: t.arg.string({ required: true }),
      linked: t.arg.boolean({ required: true }),
    },
    resolve: async (_r, { varId, appId, linked }) => {
      await setSharedVarAppLink(varId, appId, linked);
      return true;
    },
  }),
  deleteSharedVar: t.field({
    type: "Boolean",
    authScopes: { capability: "manage_env" },
    description: "Delete a shared variable. Returns true.",
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      await deleteSharedVar(id);
      return true;
    },
  }),
  revealSharedVar: t.field({
    type: "String",
    authScopes: { capability: "manage_env" },
    description:
      "Reveal one shared variable's decrypted value (the `manage_env`-gated reveal; the UI keeps secrets masked).",
    args: { id: t.arg.string({ required: true }) },
    resolve: (_r, { id }) => revealSharedVar(id),
  }),
}));
