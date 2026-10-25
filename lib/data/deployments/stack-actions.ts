import "server-only";

import { getCurrentUser } from "../../auth/current-user";
import { recordActivity } from "../activity";
import { syncProductionUrl } from "../domains/primary-domain";
import { assertNotPausedForMove } from "../deplo-move/source-guard";
import { startDeployment } from "../../deploy/build/deploy-start";
import { rerouteApp } from "../../deploy/build/reroute";
import { destroyStack } from "../../deploy/build/stack-lifecycle";
import { loadDeployment, appInTeam, appSourceInTeam } from "../app-graph-load";
import { requireAppCapability } from "../node-access";
import type { DeploySource } from "../../types/app";
import type { Deployment } from "../../types/deployment";

export async function reloadApp(
  appId: string,
): Promise<"rerouted" | "unchanged" | "deferred"> {
  const { membership } = await requireAppCapability(appId, "control_apps");
  const user = (await getCurrentUser())!;
  if (!(await appInTeam(appId, membership.teamId)))
    throw new Error("App not found");
  await assertNotPausedForMove("app", appId);
  const result = await rerouteApp(appId);
  if (result !== "deferred") await syncProductionUrl(appId);
  if (result === "rerouted")
    await recordActivity("app", `Reloaded routing`, user.name, appId);
  return result;
}

const REDEPLOY_MESSAGE: Record<DeploySource, string> = {
  github: "Redeploy of latest commit",
  git: "Redeploy of latest commit",
  "docker-image": "Redeploy of latest image",
  upload: "Redeploy of the uploaded archive",
  compose: "Redeploy of the compose stack",
};

export async function redeploy(
  appId: string,
  fromDeploymentId?: string | null,
  // Rebuild on a freshly fetched base image, for a security update that lives in it.
  opts: { pullBase?: boolean } = {},
): Promise<Deployment> {
  const { membership } = await requireAppCapability(appId, "deploy_apps");
  const user = (await getCurrentUser())!;
  const source = await appSourceInTeam(appId, membership.teamId);
  if (!source) throw new Error("App not found");
  const from = fromDeploymentId ? await loadDeployment(fromDeploymentId) : null;
  if (fromDeploymentId && from?.appId !== appId)
    throw new Error("Deployment not found");
  if (from?.environment === "preview")
    throw new Error("A preview deployment is rebuilt from its preview");
  const depId = await startDeployment(appId, {
    environment: "production",
    creator: user.name,
    commitMessage: opts.pullBase
      ? "Rebuild on a fresh base image"
      : REDEPLOY_MESSAGE[source],
    branch: from?.branch || undefined,
    pullBase: opts.pullBase ?? false,
  });
  return (await loadDeployment(depId))!;
}

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
