import "server-only";

import { getCurrentUser } from "../../auth/current-user";
import { recordActivity } from "../activity";
import { startDeployment } from "../../deploy/build/deploy-start";
import { rerouteApp } from "../../deploy/build/reroute";
import { destroyStack } from "../../deploy/build/stack-lifecycle";
import { loadDeployment, appInTeam, appSourceInTeam } from "../app-graph-load";
import { requireAppCapability } from "../node-access";
import type { DeploySource } from "../../types/app";
import type { Deployment } from "../../types/deployment";

// reloadApp re-applies a project's routing to its running stack - no rebuild.
export async function reloadApp(
  appId: string,
): Promise<"rerouted" | "unchanged" | "deferred"> {
  const { membership } = await requireAppCapability(appId, "control_apps");
  const user = (await getCurrentUser())!;
  if (!(await appInTeam(appId, membership.teamId)))
    throw new Error("App not found");
  const result = await rerouteApp(appId);
  if (result === "rerouted")
    await recordActivity("app", `Reloaded routing`, user.name, appId);
  return result;
}

// What a redeploy re-runs: only a repo has a commit to be latest.
const REDEPLOY_MESSAGE: Record<DeploySource, string> = {
  github: "Redeploy of latest commit",
  git: "Redeploy of latest commit",
  "docker-image": "Redeploy of latest image",
  upload: "Redeploy of the uploaded archive",
  compose: "Redeploy of the compose stack",
};

// redeploy triggers a fresh production build + deploy of what the app deploys from.
export async function redeploy(appId: string): Promise<Deployment> {
  const { membership } = await requireAppCapability(appId, "deploy_apps");
  const user = (await getCurrentUser())!;
  const source = await appSourceInTeam(appId, membership.teamId);
  if (!source) throw new Error("App not found");
  const depId = await startDeployment(appId, {
    environment: "production",
    creator: user.name,
    commitMessage: REDEPLOY_MESSAGE[source],
  });
  return (await loadDeployment(depId))!;
}

// teardownApp tears down a preview's stack; never throws, so a dead host can't block the caller.
export async function teardownApp(
  deployKey: string,
  opts: { removeVolumes?: boolean } = {},
): Promise<boolean> {
  try {
    await destroyStack(deployKey, opts);
    return true;
  } catch {
    return false;
  }
}
