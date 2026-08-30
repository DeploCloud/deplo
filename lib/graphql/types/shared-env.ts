// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { builder } from "../builder";
import { EnvTargetEnum } from "./enums";
import { EnvVarTypeEnum, VarAuthorRef } from "./env";
import {
  listSharedVars,
  listSharedVarsForApp,
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

/** A lightweight team reference: the owner, and every team the var reaches. */
const SharedVarTeamRef = builder
  .objectRef<SharedVarDTO["teams"][number]>("SharedVarTeam")
  .implement({
    fields: (t) => ({
      id: t.exposeID("id"),
      name: t.exposeString("name"),
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
    "A shared environment variable (ADR-0010/0012/0027). Secret values are masked. " +
    "Team / environment / project scopes say who it is AVAILABLE to, and it injects " +
    "only through explicit per-app links (opt-in) - UNLESS `autoInject`, which is " +
    "what reaching more than one team means.",
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
    teamWide: t.exposeBoolean("teamWide", {
      description: "It reaches the VIEWER's team.",
    }),
    teamIds: t.exposeIDList("teamIds"),
    teams: t.field({ type: [SharedVarTeamRef], resolve: (v) => v.teams }),
    autoInject: t.exposeBoolean("autoInject", {
      description:
        "Injects into every app of every team it reaches, with no per-app link, " +
        "at the LOWEST precedence. True when it reaches more than one team.",
    }),
    ownerTeam: t.field({
      type: SharedVarTeamRef,
      nullable: true,
      description: "The owning team; null when the instance owns it.",
      resolve: (v) => v.ownerTeam,
    }),
    editable: t.exposeBoolean("editable", {
      description:
        "The viewer's team owns it. A variable shared IN from another team is " +
        "read-only here, and its project/environment/app ids come back empty.",
    }),
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
      "(the only thing that injects - ADR-0012); `inScope`/`scope` say whether an " +
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
        description: "The app opted in - the var injects on its next deploy.",
      }),
      inScope: t.exposeBoolean("inScope", {
        description:
          "An availability scope (team / environment / project) covers this app.",
      }),
      autoInject: t.exposeBoolean("autoInject", {
        description:
          "It lands here with no link and cannot be removed from this app.",
      }),
      ownerTeamName: t.exposeString("ownerTeamName", {
        nullable: true,
        description: "The team behind an auto-injected variable.",
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
    "shared with something: ≥1 team, ≥1 environment, ≥1 project, or ≥1 app.",
  fields: (t) => ({
    id: t.string({ required: false }),
    key: t.string({ required: true }),
    value: t.string({ required: true }),
    type: t.field({ type: EnvVarTypeEnum, required: true }),
    // Omit ⇒ every deploy runtime (the UI no longer asks); see UpsertEnvInput.
    targets: t.field({ type: [EnvTargetEnum], required: false }),
    teamIds: t.idList({
      required: true,
      description:
        "Teams every app of which gets this variable. ONE team ⇒ it is only " +
        "SUGGESTED there and the per-app link injects (ADR-0012); TWO OR MORE ⇒ " +
        "it is injected into every app of every one of them, with no link, at " +
        "the lowest precedence. The caller must hold `manage_env` across the " +
        "whole of every team named here.",
    }),
    environmentIds: t.idList({ required: true }),
    projectIds: t.idList({ required: true }),
    appIds: t.stringList({
      required: false,
      description:
        "The per-app links, as a whole set. OMIT to leave the existing links " +
        "untouched - that is what preserves setSharedVarAppLink's app-side toggle.",
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
    description:
      "Create or update a shared variable; returns the saved entity.",
    args: { input: t.arg({ type: SaveSharedVarInputType, required: true }) },
    resolve: async (_r, { input }) => {
      const id = await saveSharedVar({
        id: input.id ?? undefined,
        key: input.key,
        value: input.value,
        type: input.type,
        targets: input.targets ?? undefined,
        teamIds: input.teamIds,
        environmentIds: input.environmentIds,
        projectIds: input.projectIds,
        appIds: input.appIds ?? undefined,
      });
      // Reload by the id the data fn minted - matching by key would be ambiguous
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
}));
