import "server-only";

import { and, desc, eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { deployments as deploymentsTable } from "../../db/schema/control-plane/deployments";
import { getCurrentUser } from "../../auth/current-user";
import { requireMembership } from "../../membership";
import { appBuildsItsOwnImage } from "../../utils";
import { startDeployment } from "../../deploy/build/deploy-start";
import {
  loadDeployment,
  loadDeploymentsForApp,
  appInTeam,
} from "../app-graph-load";
import { requireAppCapability } from "../node-access";
import type { Deployment } from "../../types/deployment";

const ROLLBACK_SCAN_LIMIT = 200;

// Rollback re-runs an image a past build left ON THE HOST, Deplo pushes to no registry, so it must match retention.
export async function canRollbackTo(dep: Deployment): Promise<boolean> {
  if (!dep.imageRef || dep.rollbackOf || dep.status !== "ready") return false;
  const [app] = await getDb()
    .select({
      serverId: appsTable.serverId,
      rollbackKeep: appsTable.rollbackKeep,
      source: appsTable.source,
      compose: appsTable.compose,
      repoUrl: appsTable.repoUrl,
      dockerImage: appsTable.dockerImage,
    })
    .from(appsTable)
    .where(eq(appsTable.id, dep.appId))
    .limit(1);
  if (!app) return false;
  const history = await getDb()
    .select({
      id: deploymentsTable.id,
      status: deploymentsTable.status,
      environment: deploymentsTable.environment,
      imageRef: deploymentsTable.imageRef,
      rollbackOf: deploymentsTable.rollbackOf,
      serverId: deploymentsTable.serverId,
    })
    .from(deploymentsTable)
    .where(
      and(
        eq(deploymentsTable.appId, dep.appId),
        eq(deploymentsTable.environment, "production"),
        eq(deploymentsTable.status, "ready"),
      ),
    )
    .orderBy(desc(deploymentsTable.createdAt), desc(deploymentsTable.seq))
    .limit(ROLLBACK_SCAN_LIMIT);
  return rollbackTargetIds(
    app,
    history as Parameters<typeof rollbackTargetIds>[1],
  ).has(dep.id);
}

// ponytail: ranks SUCCESSFUL builds while the host ranks IMAGES, so a target at
export function rollbackTargetIds(
  app: {
    serverId: string | null;
    rollbackKeep: number;
    source: string;
    compose: string | null;
    repoUrl: string | null;
    dockerImage: string | null;
  },
  deps: Pick<
    Deployment,
    "id" | "status" | "environment" | "imageRef" | "rollbackOf" | "serverId"
  >[],
): Set<string> {
  if (!appBuildsItsOwnImage({ ...app, repo: app.repoUrl })) return new Set();
  const production = deps.filter(
    (d) => d.environment === "production" && d.status === "ready",
  );
  const liveImage = production[0]?.imageRef ?? null;
  const builds = production.filter((d) => !d.rollbackOf && d.imageRef);
  return new Set(
    builds
      .slice(0, Math.max(0, app.rollbackKeep) + 1)
      .filter((d) => d.imageRef !== liveImage && d.serverId === app.serverId)
      .map((d) => d.id),
  );
}

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
    .select({
      serverId: appsTable.serverId,
      rollbackKeep: appsTable.rollbackKeep,
      name: appsTable.name,
      source: appsTable.source,
      compose: appsTable.compose,
      repoUrl: appsTable.repoUrl,
      dockerImage: appsTable.dockerImage,
    })
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
  if (!dep.imageRef)
    throw new Error(
      "This deployment left no image to go back to. Only an app Deplo builds - from a repository or an uploaded archive - can be rolled back.",
    );
  if (dep.rollbackOf)
    throw new Error(
      "This deployment is itself a rollback. Roll back to the deployment that built the image instead.",
    );
  if (dep.serverId !== app.serverId)
    throw new Error(
      "This deployment ran on another server, and its image stayed there. Only builds from this app's current server can be rolled back to.",
    );

  const history = await loadDeploymentsForApp(dep.appId);
  const targets = rollbackTargetIds(app, history);
  if (!targets.has(dep.id)) {
    const live =
      history.find(
        (d) => d.environment === "production" && d.status === "ready",
      )?.imageRef ?? null;
    throw new Error(
      live && live === dep.imageRef
        ? "This is the deployment the app is already running."
        : `This deployment's image is no longer kept on the server. ${app.name} keeps ${app.rollbackKeep} ${app.rollbackKeep === 1 ? "rollback" : "rollbacks"} - raise that in Settings → Deployments to keep more of them.`,
    );
  }

  const depId = await startDeployment(dep.appId, {
    environment: "production",
    creator: user.name,
    rollback: {
      deploymentId: dep.id,
      imageRef: dep.imageRef,
      commitSha: dep.commitSha,
      commitMessage: dep.commitMessage,
      commitAuthor: dep.commitAuthor,
      builtAt: dep.readyAt ?? dep.createdAt,
    },
  });
  return (await loadDeployment(depId))!;
}
