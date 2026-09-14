import { builder } from "../../builder";
import { AppRef, reloadApp } from "./app-object";
import { DeploymentRef } from "./deployment-object";
import { getAppById } from "@/lib/data/apps/listing";
import { setAppRollbackKeep } from "@/lib/data/apps/settings";
import {
  cancelDeployment,
  cancelAllDeployments,
  deleteDeployments,
  deleteAllDeployments,
} from "@/lib/data/deployments/cancel-and-delete";
import { rollbackDeployment } from "@/lib/data/deployments/rollback";
import { redeploy } from "@/lib/data/deployments/stack-actions";
import { renderAppStack } from "@/lib/deploy/build/app-stack-view";
import { acceptDataCopyLoss } from "@/lib/data/data-copy";
import { redactComposeForDisplay } from "@/lib/deploy/compose-redact";

builder.mutationFields((t) => ({
  renderComposeStack: t.field({
    type: "String",
    nullable: true,
    authScopes: { loggedIn: true },
    description: "Render the docker-compose stack an app would deploy.",
    args: { appId: t.arg.string({ required: true }) },
    resolve: async (_r, { appId }) => {
      // Team-scope the request before rendering (the render fn is unscoped).
      const project = await getAppById(appId);
      if (!project) throw new Error("App not found");
      const yaml = await renderAppStack(project.id);
      // Served at the `view` floor: mask every env VALUE and the basic-auth
      // htpasswd label, which rides a Traefik label rather than `environment:`.
      return yaml === null ? null : redactComposeForDisplay(yaml);
    },
  }),
  deployWithoutMigratedData: t.field({
    type: AppRef,
    authScopes: { capability: "deploy_apps" },
    description:
      "Accept that the data a migration could not copy is not coming, and let " +
      "this app deploy again: clears `dataCopyError`. The way out for an app " +
      "whose source machine has since been turned off, which is how a migration " +
      "normally ends. Recorded in Activity.",
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      await acceptDataCopyLoss({ kind: "app", id });
      return reloadApp(id);
    },
  }),
  redeploy: t.field({
    type: DeploymentRef,
    authScopes: { capability: "deploy_apps" },
    args: { appId: t.arg.string({ required: true }) },
    resolve: (_r, { appId }) => redeploy(appId),
  }),
  rollbackDeployment: t.field({
    type: DeploymentRef,
    authScopes: { capability: "rollback_apps" },
    description:
      "Put an app back on a previous deployment by re-running the image that " +
      "build left on the server - no clone, no rebuild, no pull. Only a " +
      "successful production deployment of an app Deplo builds (a repository or " +
      "an uploaded archive), still inside the app's rollback retention and on " +
      "the app's current server, can be rolled back to; ask for `canRollback` " +
      "on the deployment to know. The code goes back and NOTHING ELSE does: the " +
      "stack is rendered from the app's current variables, domains, volumes and " +
      "resource limits. Returns the new deployment.",
    args: { deploymentId: t.arg.string({ required: true }) },
    resolve: (_r, { deploymentId }) => rollbackDeployment(deploymentId),
  }),
  setAppRollbackKeep: t.field({
    type: AppRef,
    // `configure_apps`, not `rollback_apps`: how many rollbacks an app keeps is
    // how much disk its images hold on the server, which is a setting, not the
    // act of going back.
    authScopes: { capability: "configure_apps" },
    description:
      "How many previous deployments this app can be rolled back to (0-20, " +
      "default 3). It is retention: the app's server keeps this many of its " +
      "images behind the running one. Takes effect on the next sweep - lowering " +
      "it removes nothing now, and raising it cannot bring back images already " +
      "removed.",
    args: {
      id: t.arg.string({ required: true }),
      count: t.arg.int({ required: true }),
    },
    resolve: async (_r, { id, count }) => {
      await setAppRollbackKeep(id, count);
      return reloadApp(id);
    },
  }),
  cancelDeployment: t.field({
    type: "Boolean",
    authScopes: { capability: "deploy_apps" },
    args: { id: t.arg.string({ required: true }) },
    // Returns false if the deployment had already finished (nothing to stop).
    resolve: (_r, { id }) => cancelDeployment(id),
  }),
  cancelAllDeployments: t.field({
    type: "Int",
    authScopes: { capability: "deploy_apps" },
    description:
      "Cancel every in-progress deployment (queued/building) for one app (appId given) or across the whole active team (appId omitted), optionally narrowed to the deployments view filters: one owning server (serverId), one environment, and/or one status. Terminal deployments are left. Returns how many builds were stopped.",
    args: {
      appId: t.arg.id({ required: false }),
      serverId: t.arg.id({ required: false }),
      environment: t.arg.string({ required: false }),
      status: t.arg.string({ required: false }),
    },
    resolve: (_r, { appId, serverId, environment, status }) =>
      cancelAllDeployments(
        appId != null ? String(appId) : null,
        serverId != null ? String(serverId) : null,
        environment != null ? String(environment) : null,
        status != null ? String(status) : null,
      ),
  }),
  deleteDeployments: t.field({
    type: "Int",
    authScopes: { capability: "delete_apps" },
    description:
      "Delete finished deployments (ready/error/canceled) by id; in-progress ones (queued/building) are left to be canceled first. Returns how many were deleted.",
    args: { ids: t.arg.idList({ required: true }) },
    resolve: (_r, { ids }) => deleteDeployments(ids.map(String)),
  }),
  deleteAllDeployments: t.field({
    type: "Int",
    authScopes: { capability: "delete_apps" },
    description:
      "Delete every finished deployment for one app (appId given) or across the whole active team (appId omitted), optionally narrowed to the deployments view filters: one owning server (serverId), one environment, and/or one status. In-progress deployments are left. Returns how many were deleted.",
    args: {
      appId: t.arg.id({ required: false }),
      serverId: t.arg.id({ required: false }),
      environment: t.arg.string({ required: false }),
      status: t.arg.string({ required: false }),
    },
    resolve: (_r, { appId, serverId, environment, status }) =>
      deleteAllDeployments(
        appId != null ? String(appId) : null,
        serverId != null ? String(serverId) : null,
        environment != null ? String(environment) : null,
        status != null ? String(status) : null,
      ),
  }),
}));
