import "server-only";

import { cache } from "react";
import { and, desc, eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { deployments as deploymentsTable } from "../../db/schema/control-plane/deployments";
import { getCurrentUser } from "../../auth/current-user";
import { requireActiveTeamId, requireMembership } from "../../membership";
import { appBuildsItsOwnImage } from "../../utils";
import { isOwnImage } from "../../deploy/deploy-key";
import { startDeployment } from "../../deploy/build/deploy-start";
import {
  loadDeployment,
  loadDeploymentsForApp,
  appInTeam,
} from "../app-graph-load";
import { requireAppCapability } from "../node-access";
import type { Deployment } from "../../types/deployment";

const ROLLBACK_SCAN_LIMIT = 200;

// "instant" re-runs an image still on the host; "rebuild" builds the commit again once that image was pruned.
export type RollbackMode = "instant" | "rebuild";

type RollbackApp = {
  serverId: string | null;
  rollbackKeep: number;
  source: string;
  compose: string | null;
  repoUrl: string | null;
  dockerImage: string | null;
};

type RollbackHistoryRow = Pick<
  Deployment,
  | "id"
  | "status"
  | "environment"
  | "imageRef"
  | "rollbackOf"
  | "serverId"
  | "commitSha"
>;

const APP_COLUMNS = {
  serverId: appsTable.serverId,
  rollbackKeep: appsTable.rollbackKeep,
  source: appsTable.source,
  compose: appsTable.compose,
  repoUrl: appsTable.repoUrl,
  dockerImage: appsTable.dockerImage,
};

function productionHistory(appId: string) {
  return getDb()
    .select({
      id: deploymentsTable.id,
      status: deploymentsTable.status,
      environment: deploymentsTable.environment,
      imageRef: deploymentsTable.imageRef,
      rollbackOf: deploymentsTable.rollbackOf,
      serverId: deploymentsTable.serverId,
      commitSha: deploymentsTable.commitSha,
      commitMessage: deploymentsTable.commitMessage,
    })
    .from(deploymentsTable)
    .where(
      and(
        eq(deploymentsTable.appId, appId),
        eq(deploymentsTable.environment, "production"),
        eq(deploymentsTable.status, "ready"),
      ),
    )
    .orderBy(desc(deploymentsTable.createdAt), desc(deploymentsTable.seq))
    .limit(ROLLBACK_SCAN_LIMIT);
}

// Rollback re-runs an image a past build left ON THE HOST, Deplo pushes to no registry, so it must match retention.
export async function rollbackModeFor(
  dep: Deployment,
): Promise<RollbackMode | null> {
  if (dep.status !== "ready" || dep.environment !== "production") return null;
  const [app] = await getDb()
    .select(APP_COLUMNS)
    .from(appsTable)
    .where(eq(appsTable.id, dep.appId))
    .limit(1);
  if (!app) return null;
  const history = await productionHistory(dep.appId);
  return (
    rollbackTargets(app, history as RollbackHistoryRow[]).get(dep.id) ?? null
  );
}

// ponytail: ranks SUCCESSFUL builds while the host ranks IMAGES, so a target at
export function rollbackTargets(
  app: RollbackApp,
  deps: RollbackHistoryRow[],
): Map<string, RollbackMode> {
  const out = new Map<string, RollbackMode>();
  if (!appBuildsItsOwnImage({ ...app, repo: app.repoUrl })) return out;
  const production = deps.filter(
    (d) => d.environment === "production" && d.status === "ready",
  );
  const live = production[0];
  if (!live) return out;
  // A rollback that rebuilt its commit made an image of its own; one that re-ran another's did not.
  const builds = production.filter(
    (d) => !d.rollbackOf || (d.imageRef && isOwnImage(d.imageRef, d.id)),
  );
  for (const d of builds
    .filter((d) => d.imageRef)
    .slice(0, Math.max(0, app.rollbackKeep) + 1)) {
    if (d.imageRef !== live.imageRef && d.serverId === app.serverId)
      out.set(d.id, "instant");
  }
  if (!app.repoUrl || (app.source !== "github" && app.source !== "git"))
    return out;
  for (const d of builds) {
    if (
      !out.has(d.id) &&
      d.id !== live.id &&
      d.commitSha &&
      d.commitSha !== live.commitSha
    )
      out.set(d.id, "rebuild");
  }
  return out;
}

// The deployment the app goes back to from the header: the newest one before the live one.
export const rollbackTarget = cache(async function rollbackTarget(
  appId: string,
): Promise<{
  id: string;
  commitSha: string;
  commitMessage: string;
  rebuild: boolean;
} | null> {
  const teamId = await requireActiveTeamId();
  const [app] = await getDb()
    .select(APP_COLUMNS)
    .from(appsTable)
    .where(and(eq(appsTable.id, appId), eq(appsTable.teamId, teamId)))
    .limit(1);
  if (!app) return null;
  const history = await productionHistory(appId);
  const targets = rollbackTargets(app, history as RollbackHistoryRow[]);
  const target = history.find((d) => targets.has(d.id));
  return target
    ? {
        id: target.id,
        commitSha: target.commitSha,
        commitMessage: target.commitMessage,
        rebuild: targets.get(target.id) === "rebuild",
      }
    : null;
});

export async function rollbackDeployment(
  deploymentId: string,
): Promise<Deployment> {
  await requireMembership();
  const user = (await getCurrentUser())!;
  const dep = await loadDeployment(deploymentId);
  if (!dep) throw new Error("Deployment not found");
  const { membership } = await requireAppCapability(dep.appId, "rollback_apps");
  if (!(await appInTeam(dep.appId, membership.teamId)))
    throw new Error("Deployment not found");

  const [app] = await getDb()
    .select({ ...APP_COLUMNS, name: appsTable.name })
    .from(appsTable)
    .where(
      and(eq(appsTable.id, dep.appId), eq(appsTable.teamId, membership.teamId)),
    )
    .limit(1);
  if (!app) throw new Error("App not found");

  if (!appBuildsItsOwnImage({ ...app, repo: app.repoUrl })) {
    throw new Error(
      "This app doesn't build an image Deplo can re-run, so it has nothing to roll back to. Only an app deployed from a repository or an uploaded archive can.",
    );
  }

  if (dep.environment !== "production")
    throw new Error(
      "Only a production deployment can be rolled back to - a pull request preview is torn down with its pull request.",
    );
  if (dep.status !== "ready")
    throw new Error(
      `Only a deployment that finished successfully can be rolled back to (this one is ${dep.status}).`,
    );
  if (dep.rollbackOf && !(dep.imageRef && isOwnImage(dep.imageRef, dep.id)))
    throw new Error(
      "This deployment is itself a rollback. Roll back to the deployment that built the image instead.",
    );

  const history = await loadDeploymentsForApp(dep.appId);
  const mode = rollbackTargets(app, history).get(dep.id);
  if (!mode) {
    const live = history.find(
      (d) => d.environment === "production" && d.status === "ready",
    );
    if (
      live &&
      (live.id === dep.id || (dep.imageRef && live.imageRef === dep.imageRef))
    )
      throw new Error("This is the deployment the app is already running.");
    if (live && dep.commitSha && live.commitSha === dep.commitSha)
      throw new Error("The app is already running this commit.");
    if (!dep.imageRef)
      throw new Error(
        "This deployment left no image to go back to. Only an app Deplo builds - from a repository or an uploaded archive - can be rolled back.",
      );
    if (dep.serverId !== app.serverId)
      throw new Error(
        "This deployment ran on another server, and its image stayed there. Only builds from this app's current server can be rolled back to.",
      );
    throw new Error(
      `This deployment's image is no longer kept on the server. ${app.name} keeps ${app.rollbackKeep} ${app.rollbackKeep === 1 ? "rollback" : "rollbacks"} - raise that in Settings → Deployments to keep more of them.`,
    );
  }

  const depId = await startDeployment(dep.appId, {
    environment: "production",
    creator: user.name,
    branch: dep.branch,
    rollback: {
      deploymentId: dep.id,
      imageRef: mode === "instant" ? dep.imageRef : null,
      commitSha: dep.commitSha,
      commitMessage: dep.commitMessage,
      commitAuthor: dep.commitAuthor,
      builtAt: dep.readyAt ?? dep.createdAt,
    },
  });
  return (await loadDeployment(depId))!;
}
