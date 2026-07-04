import "server-only";

import { desc, eq, inArray } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  deployments as deploymentsTable,
  projects as projectsTable,
} from "../db/schema/control-plane";
import { getCurrentUser } from "../auth";
import { nowIso } from "../ids";
import { requireActiveTeamId, requireCapability } from "../membership";
import { recordActivity } from "./activity";
import { startDeployment, destroyStack, rerouteProject } from "../deploy/build";
import {
  loadDeployment,
  loadDeploymentsForProject,
  projectInTeam,
} from "./project-graph-load";
import { assembleDeployment } from "./project-graph-rows";
import { loadDeploymentLogs } from "./deployment-logs";
import { requireFolderCapabilityForProject } from "./folder-access";
import type { Deployment, DeploymentEnvironment, LogLine } from "../types";

export async function listDeployments(filter?: {
  projectId?: string;
  environment?: DeploymentEnvironment;
  status?: Deployment["status"];
}): Promise<(Deployment & { projectName: string; projectSlug: string })[]> {
  const teamId = await requireActiveTeamId();
  // The caller's team projects, by id (the deployment join target + the name/slug
  // decoration). One query; deployments are scoped to these.
  const teamProjects = await getDb()
    .select({
      id: projectsTable.id,
      name: projectsTable.name,
      slug: projectsTable.slug,
    })
    .from(projectsTable)
    .where(eq(projectsTable.teamId, teamId));
  const byId = new Map(teamProjects.map((p) => [p.id, p] as const));
  const projectIds = filter?.projectId
    ? byId.has(filter.projectId)
      ? [filter.projectId]
      : []
    : teamProjects.map((p) => p.id);
  if (projectIds.length === 0) return [];

  // Newest-first with the deterministic seq tie-break, push-down into SQL.
  const rows = await getDb()
    .select()
    .from(deploymentsTable)
    .where(inArray(deploymentsTable.projectId, projectIds))
    .orderBy(desc(deploymentsTable.createdAt), desc(deploymentsTable.seq));

  return rows
    .map(assembleDeployment)
    .filter((x) => !filter?.environment || x.environment === filter.environment)
    .filter((x) => !filter?.status || x.status === filter.status)
    .map((x) => {
      const p = byId.get(x.projectId);
      return { ...x, projectName: p?.name ?? "", projectSlug: p?.slug ?? "" };
    });
}

export async function getDeployment(id: string): Promise<Deployment | null> {
  const teamId = await requireActiveTeamId();
  const dep = await loadDeployment(id);
  if (!dep) return null;
  return (await projectInTeam(dep.projectId, teamId)) ? dep : null;
}

export async function getLogs(deploymentId: string): Promise<LogLine[]> {
  const teamId = await requireActiveTeamId();
  const dep = await loadDeployment(deploymentId);
  if (!dep) return [];
  if (!(await projectInTeam(dep.projectId, teamId))) return [];
  return loadDeploymentLogs(deploymentId);
}

/**
 * Re-apply a project's routing to its already-running stack — no rebuild, no
 * redeploy. Re-renders the on-disk stack with the project's CURRENT domains
 * (primary first) and basic-auth, then `docker compose up -d` recreates only the
 * routed service in place so the new Traefik labels take effect in seconds. This
 * is the "Reload" action that replaced "Rebuild" for routing-only changes
 * (added/removed/primary-switched domains, basic-auth edits) — far cheaper than a
 * full image rebuild. The outcome the caller surfaces:
 *  - "rerouted"  — routing was re-applied to the running container
 *  - "unchanged" — labels already matched; nothing to do
 *  - "deferred"  — saved, but it applies on the next deploy/start (the project
 *                  isn't active, was never deployed, or has no domain)
 */
export async function reloadProject(
  projectId: string,
): Promise<"rerouted" | "unchanged" | "deferred"> {
  const { membership } = await requireCapability("deploy");
  const user = (await getCurrentUser())!;
  if (!(await projectInTeam(projectId, membership.teamId)))
    throw new Error("Project not found");
  await requireFolderCapabilityForProject(projectId, "deploy");
  const result = await rerouteProject(projectId);
  if (result === "rerouted")
    await recordActivity("project", `Reloaded routing`, user.name, projectId);
  return result;
}

/** Trigger a fresh production build + deploy of the latest commit. */
export async function redeploy(projectId: string): Promise<Deployment> {
  const { membership } = await requireCapability("deploy");
  const user = (await getCurrentUser())!;
  if (!(await projectInTeam(projectId, membership.teamId)))
    throw new Error("Project not found");
  await requireFolderCapabilityForProject(projectId, "deploy");
  const depId = await startDeployment(projectId, {
    environment: "production",
    creator: user.name,
    commitMessage: "Redeploy of latest commit",
  });
  return (await loadDeployment(depId))!;
}

export async function cancelDeployment(id: string): Promise<void> {
  const { membership } = await requireCapability("deploy");
  const dep = await loadDeployment(id);
  if (!dep) throw new Error("Deployment not found");
  if (!(await projectInTeam(dep.projectId, membership.teamId)))
    throw new Error("Deployment not found");
  await requireFolderCapabilityForProject(dep.projectId, "deploy");
  // Only a queued/building deployment can be cancelled; a conditional UPDATE so
  // a terminal one is left as-is.
  if (dep.status === "building" || dep.status === "queued") {
    await getDb()
      .update(deploymentsTable)
      .set({ status: "canceled" })
      .where(eq(deploymentsTable.id, id));
  }
}

export async function promoteToProduction(id: string): Promise<void> {
  const { membership } = await requireCapability("deploy");
  const user = (await getCurrentUser())!;
  const existing = await loadDeployment(id);
  if (!existing) throw new Error("Deployment not found");
  if (!(await projectInTeam(existing.projectId, membership.teamId)))
    throw new Error("Deployment not found");
  await requireFolderCapabilityForProject(existing.projectId, "deploy");
  // One tx: flip the deployment to production AND point the project at it.
  await getDb().transaction(async (tx) => {
    const dep = await tx
      .select()
      .from(deploymentsTable)
      .where(eq(deploymentsTable.id, id))
      .limit(1);
    if (dep.length === 0) throw new Error("Deployment not found");
    await tx
      .update(deploymentsTable)
      .set({ environment: "production" })
      .where(eq(deploymentsTable.id, id));
    await tx
      .update(projectsTable)
      .set({
        latestDeploymentId: id,
        productionUrl: dep[0]!.url,
        updatedAt: nowIso(),
      })
      .where(eq(projectsTable.id, dep[0]!.projectId));
  });
  await recordActivity(
    "deployment",
    `Promoted deployment to production`,
    user.name,
    null,
    membership.teamId,
  );
}

/**
 * A project's deployments, newest-first. Thin wrapper over the loader's SQL
 * push-down so the GraphQL `Project.deployments` resolver doesn't load the whole
 * history into memory.
 */
export async function listProjectDeployments(
  projectId: string,
  opts: { limit?: number } = {},
): Promise<Deployment[]> {
  return loadDeploymentsForProject(projectId, opts);
}

/**
 * Tear down a project's running stack (used when deleting the project). Returns
 * `true` if the stack was destroyed, `false` if teardown failed — for a REMOTE
 * project that means an unreachable agent, in which case the delete proceeds
 * anyway (P6 spirit) and the caller warns that leftover containers on the remote
 * must be cleaned by hand. Never throws, so a dead remote never blocks a delete.
 */
export async function teardownProject(slug: string): Promise<boolean> {
  try {
    await destroyStack(slug);
    return true;
  } catch {
    return false;
  }
}
