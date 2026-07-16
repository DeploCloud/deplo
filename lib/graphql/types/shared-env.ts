import { builder } from "../builder";
import { EnvTargetEnum } from "./enums";
import { EnvVarTypeEnum, VarAuthorRef } from "./env";
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

/** One unified shared variable: availability scopes + opt-in per-app links. */
const SharedVarRef = builder.objectRef<SharedVarDTO>("SharedVar").implement({
  description:
    "A shared environment variable (ADR-0010/0012). Secret values are masked. " +
    "Team-wide / environment / project scopes say who it is AVAILABLE to; it " +
    "injects only through explicit per-app links (opt-in).",
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
    createdBy: t.field({
      type: VarAuthorRef,
      nullable: true,
      resolve: (v) => v.createdBy,
    }),
    updatedBy: t.field({
      type: VarAuthorRef,
      nullable: true,
      resolve: (v) => v.updatedBy,
    }),
    createdAt: t.exposeString("createdAt"),
    updatedAt: t.exposeString("updatedAt"),
  }),
});

/** A shared var as seen from one app: its opt-in state + availability scope. */
const AppSharedVarRef = builder
  .objectRef<AppSharedVarDTO>("AppSharedVar")
  .implement({
    description:
      "A shared variable as seen from one app. `linked` is the explicit opt-in " +
      "(the only thing that injects — ADR-0012); `inScope`/`scope` say whether an " +
      "availability scope suggests it here.",
    fields: (t) => ({
      id: t.exposeID("id"),
      key: t.exposeString("key"),
      value: t.exposeString("value", {
        description: "Masked for secrets, like SharedVar.value.",
      }),
      masked: t.exposeBoolean("masked"),
      type: t.field({ type: EnvVarTypeEnum, resolve: (v) => v.type }),
      targets: t.field({ type: [EnvTargetEnum], resolve: (v) => v.targets }),
      linked: t.exposeBoolean("linked", {
        description: "The app opted in — the var injects on its next deploy.",
      }),
      inScope: t.exposeBoolean("inScope", {
        description:
          "An availability scope (team-wide / environment / project) covers this app.",
      }),
      scope: t.exposeString("scope", {
        nullable: true,
        description:
          "The most specific covering scope: teamWide | environment | project.",
      }),
      // No `createdBy` here: the data layer already falls back to the creator,
      // so this is the single "Modified by" the app's table renders.
      updatedBy: t.field({
        type: VarAuthorRef,
        nullable: true,
        resolve: (v) => v.updatedBy,
      }),
      updatedAt: t.exposeString("updatedAt"),
    }),
  });

/* ------------------------------------------------------------------ */
/* Inputs                                                              */
/* ------------------------------------------------------------------ */

const SaveSharedVarInputType = builder.inputType("SaveSharedVarInput", {
  description:
    "Create (omit id) or update (provide id) one shared variable. It must be " +
    "shared with something: teamWide, ≥1 environment, ≥1 project, or ≥1 app.",
  fields: (t) => ({
    id: t.string({ required: false }),
    key: t.string({ required: true }),
    value: t.string({ required: true }),
    type: t.field({ type: EnvVarTypeEnum, required: true }),
    // Omit ⇒ every deploy runtime (the UI no longer asks); see UpsertEnvInput.
    targets: t.field({ type: [EnvTargetEnum], required: false }),
    teamWide: t.boolean({ required: true }),
    environmentIds: t.idList({ required: true }),
    projectIds: t.idList({ required: true }),
    appIds: t.stringList({
      required: false,
      description:
        "The per-app links, as a whole set. OMIT to leave the existing links " +
        "untouched — that is what preserves setSharedVarAppLink's app-side toggle.",
    }),
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
      "Every team shared variable as seen from one app, with its opt-in (link) state.",
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
        targets: input.targets ?? undefined,
        teamWide: input.teamWide,
        environmentIds: input.environmentIds,
        projectIds: input.projectIds,
        appIds: input.appIds ?? undefined,
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
