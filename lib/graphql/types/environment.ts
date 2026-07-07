import { builder } from "../builder";
import {
  listEnvironmentsForProject,
  createEnvironment,
  renameEnvironment,
  setEnvironmentBranch,
  setDefaultEnvironment,
  deleteEnvironment,
} from "@/lib/data/environments";
import type { Environment } from "@/lib/types";

/* ------------------------------------------------------------------ */
/* Object type — an Environment (ADR-0008 Phase 3)                     */
/* ------------------------------------------------------------------ */

export const EnvironmentRef = builder
  .objectRef<Environment>("Environment")
  .implement({
    description:
      "A per-Project, first-class isolated deploy target (Development/Preview/" +
      "Production + custom). `kind` is its well-known role; `slug` and `gitBranch` " +
      "drive the deploy pipeline (wired in a later phase).",
    fields: (t) => ({
      id: t.exposeID("id"),
      projectId: t.exposeID("projectId"),
      name: t.exposeString("name"),
      slug: t.exposeString("slug"),
      kind: t.exposeString("kind"),
      gitBranch: t.exposeString("gitBranch"),
      isDefault: t.exposeBoolean("isDefault"),
      position: t.exposeInt("position"),
      createdAt: t.exposeString("createdAt"),
      updatedAt: t.exposeString("updatedAt"),
    }),
  });

/* ------------------------------------------------------------------ */
/* Query                                                               */
/* ------------------------------------------------------------------ */

builder.queryFields((t) => ({
  environments: t.field({
    type: [EnvironmentRef],
    authScopes: { loggedIn: true },
    description: "The environments of a Project container, in display order.",
    args: { projectId: t.arg.id({ required: true }) },
    resolve: (_r, { projectId }) => listEnvironmentsForProject(String(projectId)),
  }),
}));

/* ------------------------------------------------------------------ */
/* Mutations                                                           */
/* ------------------------------------------------------------------ */

const deployScope = { capability: "deploy" } as const;

builder.mutationFields((t) => ({
  createEnvironment: t.field({
    type: EnvironmentRef,
    authScopes: deployScope,
    description: "Add a custom environment to a Project container.",
    args: {
      projectId: t.arg.id({ required: true }),
      name: t.arg.string({ required: true }),
    },
    resolve: (_r, { projectId, name }) =>
      createEnvironment(String(projectId), name),
  }),
  renameEnvironment: t.field({
    type: "Boolean",
    authScopes: deployScope,
    description: "Rename an environment.",
    args: {
      id: t.arg.id({ required: true }),
      name: t.arg.string({ required: true }),
    },
    resolve: async (_r, { id, name }) => {
      await renameEnvironment(String(id), name);
      return true;
    },
  }),
  setEnvironmentBranch: t.field({
    type: "Boolean",
    authScopes: deployScope,
    description:
      "Set the git branch an environment builds from (empty ⇒ the service's default branch).",
    args: {
      id: t.arg.id({ required: true }),
      branch: t.arg.string({ required: true }),
    },
    resolve: async (_r, { id, branch }) => {
      await setEnvironmentBranch(String(id), branch);
      return true;
    },
  }),
  setDefaultEnvironment: t.field({
    type: "Boolean",
    authScopes: deployScope,
    description: "Make an environment the project's default (unsets the previous one).",
    args: { id: t.arg.id({ required: true }) },
    resolve: async (_r, { id }) => {
      await setDefaultEnvironment(String(id));
      return true;
    },
  }),
  deleteEnvironment: t.field({
    type: "Boolean",
    authScopes: deployScope,
    description:
      "Delete a non-default environment (never the default or the last remaining one).",
    args: { id: t.arg.id({ required: true }) },
    resolve: async (_r, { id }) => {
      await deleteEnvironment(String(id));
      return true;
    },
  }),
}));
