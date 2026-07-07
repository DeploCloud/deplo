import { builder } from "../builder";
import {
  listProjects,
  getProjectBySlug,
  createProject,
  renameProject,
  setProjectColor,
  deleteProject,
  reorderProjects,
  moveFolderToProject,
  moveServiceToProject,
  type ProjectSummary,
} from "@/lib/data/projects";
import { listEnvironmentsForProject } from "@/lib/data/environments";
import { EnvironmentRef } from "./environment";
import type { Project } from "@/lib/types";

/* ------------------------------------------------------------------ */
/* Object type — the Project CONTAINER (ADR-0008)                      */
/* ------------------------------------------------------------------ */

export const ProjectRef = builder
  .objectRef<Project | ProjectSummary>("Project")
  .implement({
    description:
      "A top-level, team-scoped CONTAINER (ADR-0008): folder-like, but it owns " +
      "Environments and holds folders/services via their `projectId`. NOT the " +
      "deployable app — that is a `Service`. A Project never nests in a Project.",
    fields: (t) => ({
      id: t.exposeID("id"),
      teamId: t.exposeID("teamId"),
      name: t.exposeString("name"),
      slug: t.exposeString("slug"),
      color: t.exposeString("color", { nullable: true }),
      ownerUserId: t.exposeID("ownerUserId", { nullable: true }),
      createdAt: t.exposeString("createdAt"),
      updatedAt: t.exposeString("updatedAt"),
      // Live counts (present on the list/summary shape; 0 on a bare Project).
      folderCount: t.int({
        resolve: (p) => ("folderCount" in p ? p.folderCount : 0),
      }),
      serviceCount: t.int({
        resolve: (p) => ("serviceCount" in p ? p.serviceCount : 0),
      }),
      // The container's environments (seeded Development/Preview/Production).
      environments: t.field({
        type: [EnvironmentRef],
        resolve: (p) => listEnvironmentsForProject(p.id),
      }),
    }),
  });

/* ------------------------------------------------------------------ */
/* Query                                                               */
/* ------------------------------------------------------------------ */

builder.queryFields((t) => ({
  projects: t.field({
    type: [ProjectRef],
    authScopes: { loggedIn: true },
    description: "All Project containers in the active team, in display order.",
    resolve: () => listProjects(),
  }),
  project: t.field({
    type: ProjectRef,
    nullable: true,
    authScopes: { loggedIn: true },
    description: "A single Project container by its team-scoped slug, or null.",
    args: { slug: t.arg.string({ required: true }) },
    resolve: (_r, { slug }) => getProjectBySlug(slug),
  }),
}));

/* ------------------------------------------------------------------ */
/* Mutations                                                           */
/* ------------------------------------------------------------------ */

// The team-wide container order (like reorderFolders/reorderServices) stays gated
// on a super-user: instance admin OR manage_team.
const reorderScope = {
  $any: { instanceAdmin: true, capability: "manage_team" },
} as const;

// Every other container mutation needs `deploy` (the same gate as creating a
// folder or a service); the data layer re-verifies team scope. Per-container
// owner+grants (cloning folder-access) is a follow-up.
const deployScope = { capability: "deploy" } as const;

builder.mutationFields((t) => ({
  createProject: t.field({
    type: ProjectRef,
    authScopes: deployScope,
    description:
      "Create a Project container in the active team. Requires `deploy`; the creator becomes its owner.",
    args: {
      name: t.arg.string({ required: true }),
      color: t.arg.string({ required: false }),
    },
    resolve: (_r, { name, color }) => createProject(name, color ?? null),
  }),
  renameProject: t.field({
    type: "Boolean",
    authScopes: deployScope,
    description: "Rename a Project container.",
    args: {
      id: t.arg.id({ required: true }),
      name: t.arg.string({ required: true }),
    },
    resolve: async (_r, { id, name }) => {
      await renameProject(String(id), name);
      return true;
    },
  }),
  setProjectColor: t.field({
    type: "Boolean",
    authScopes: deployScope,
    description:
      "Set a Project container's accent colour (hex), or clear it when color is omitted/null.",
    args: {
      id: t.arg.id({ required: true }),
      color: t.arg.string({ required: false }),
    },
    resolve: async (_r, { id, color }) => {
      await setProjectColor(String(id), color ?? null);
      return true;
    },
  }),
  deleteProject: t.field({
    type: "Boolean",
    authScopes: deployScope,
    description:
      "Delete a Project container; its folders and services fall back to the team top level (not deleted).",
    args: { id: t.arg.id({ required: true }) },
    resolve: async (_r, { id }) => {
      await deleteProject(String(id));
      return true;
    },
  }),
  reorderProjects: t.field({
    type: "Boolean",
    authScopes: reorderScope,
    description: "Set the team-wide display order of Project containers.",
    args: { projectIds: t.arg.idList({ required: true }) },
    resolve: async (_r, { projectIds }) => {
      await reorderProjects(projectIds.map(String));
      return true;
    },
  }),
  moveFolderToProject: t.field({
    type: "Boolean",
    authScopes: deployScope,
    description:
      "Move a folder into a Project container, or back to the top level when projectId is omitted/null.",
    args: {
      folderId: t.arg.id({ required: true }),
      projectId: t.arg.id({ required: false }),
    },
    resolve: async (_r, { folderId, projectId }) => {
      await moveFolderToProject(
        String(folderId),
        projectId != null ? String(projectId) : null,
      );
      return true;
    },
  }),
  moveServiceToProject: t.field({
    type: "Boolean",
    authScopes: deployScope,
    description:
      "Move a service into a Project container, or back to the top level when projectId is omitted/null.",
    args: {
      serviceId: t.arg.id({ required: true }),
      projectId: t.arg.id({ required: false }),
    },
    resolve: async (_r, { serviceId, projectId }) => {
      await moveServiceToProject(
        String(serviceId),
        projectId != null ? String(projectId) : null,
      );
      return true;
    },
  }),
}));
