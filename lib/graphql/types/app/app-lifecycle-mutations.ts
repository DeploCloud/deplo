import { builder } from "../../builder";
import { AppRef, reloadApp } from "./app-object";
import { bulkAppAction } from "@/lib/data/apps/bulk";
import { startAppDelete, startAppsDelete } from "@/lib/data/apps/delete";
import { stopApp, startApp, rebuildApp } from "@/lib/data/apps/lifecycle";
import { transferAppToTeam } from "@/lib/data/app-transfer";
import { reloadApp as reapplyRouting } from "@/lib/data/deployments/stack-actions";

// Redeploy is its own mutation: it is a different permission (`deploy_apps`).
const BulkAppActionEnum = builder.enumType("BulkAppAction", {
  description:
    "A lifecycle action run over every app in a folder or project: start, " +
    "stop, or restart (stop then start).",
  values: ["start", "stop", "restart"] as const,
});

const BulkAppActionResultRef = builder
  .objectRef<{ ok: number; failed: number; error: string | null }>(
    "BulkAppActionResult",
  )
  .implement({
    description:
      "The outcome of a bulk action: how many apps it ran on, how many " +
      "refused or failed, and the first failure's message. Apps the caller " +
      "can't reach are not counted at all.",
    fields: (t) => ({
      ok: t.exposeInt("ok"),
      failed: t.exposeInt("failed"),
      error: t.exposeString("error", { nullable: true }),
    }),
  });

builder.mutationFields((t) => ({
  stopApp: t.field({
    type: AppRef,
    authScopes: { capability: "control_apps" },
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      await stopApp(id);
      return reloadApp(id);
    },
  }),
  startApp: t.field({
    type: AppRef,
    authScopes: { capability: "control_apps" },
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      await startApp(id);
      return reloadApp(id);
    },
  }),
  rebuildApp: t.field({
    type: AppRef,
    description:
      "Rebuild the image from the current source and REPLACE the running " +
      "container, even if nothing about the stack changed. Volumes, domains " +
      "and data are untouched.",
    authScopes: { capability: "deploy_apps" },
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      await rebuildApp(id);
      return reloadApp(id);
    },
  }),
  reloadApp: t.field({
    type: "String",
    authScopes: { capability: "control_apps" },
    description:
      "Re-apply the app's routing (domains + basic auth) to the running stack without a rebuild. Returns 'rerouted', 'unchanged', or 'deferred'.",
    args: { id: t.arg.string({ required: true }) },
    resolve: (_r, { id }) => reapplyRouting(id),
  }),
  transferAppToTeam: t.field({
    type: "Boolean",
    // `deploy` is the introspectable floor; the data layer additionally demands
    // `manage_env` here (the app carries its encrypted variables across a
    // tenancy boundary) and `deploy` in the DESTINATION team.
    authScopes: { capability: "move_apps" },
    description:
      "Hand this app over to another team the viewer belongs to. The app keeps " +
      "running: it leaves its folder/project, loses its shared-variable links " +
      "and backup schedules, and keeps its GitHub connection only if the " +
      "destination team has its own installation on that account. Returns true.",
    args: {
      appId: t.arg.string({ required: true }),
      teamId: t.arg.string({ required: true }),
    },
    resolve: async (_r, { appId, teamId }) => {
      await transferAppToTeam(appId, teamId);
      return true;
    },
  }),
  deleteApp: t.field({
    type: "Boolean",
    authScopes: { capability: "delete_apps" },
    description:
      "Delete the app. Returns as soon as the deletion is RECORDED - from that " +
      "moment the app is refused by every gate and gone from the product, and " +
      "the stack teardown finishes on the host behind the response.",
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      await startAppDelete(id);
      return true;
    },
  }),
  deleteApps: t.field({
    type: "Int",
    authScopes: { capability: "delete_apps" },
    description:
      "Bulk-delete several apps. Returns how many were recorded as deleted; the " +
      "bounded-concurrency teardown runs behind the response.",
    args: { ids: t.arg.idList({ required: true }) },
    resolve: (_r, { ids }) => startAppsDelete(ids.map(String)),
  }),
  bulkAppAction: t.field({
    type: BulkAppActionResultRef,
    authScopes: { capability: "control_apps" },
    description:
      "Start, stop or restart EVERY app in one folder (its whole subtree) or " +
      "one project (every environment). Gated again per app, so it only " +
      "touches the ones the caller may control; one failure never stops the " +
      "rest. Give exactly one of folderId / projectId.",
    args: {
      action: t.arg({ type: BulkAppActionEnum, required: true }),
      folderId: t.arg.id({ required: false }),
      projectId: t.arg.id({ required: false }),
    },
    resolve: (_r, { action, folderId, projectId }) =>
      bulkAppAction(action, {
        folderId: folderId ? String(folderId) : null,
        projectId: projectId ? String(projectId) : null,
      }),
  }),
  bulkRedeployApps: t.field({
    type: BulkAppActionResultRef,
    authScopes: { capability: "deploy_apps" },
    description:
      "Redeploy EVERY app in one folder (its whole subtree) or one project " +
      "(every environment): the bulk twin of `redeploy`. Give exactly one " +
      "of folderId / projectId.",
    args: {
      folderId: t.arg.id({ required: false }),
      projectId: t.arg.id({ required: false }),
    },
    resolve: (_r, { folderId, projectId }) =>
      bulkAppAction("redeploy", {
        folderId: folderId ? String(folderId) : null,
        projectId: projectId ? String(projectId) : null,
      }),
  }),
}));
