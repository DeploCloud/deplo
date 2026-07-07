import "server-only";

import { desc, eq, inArray } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  deployments as deploymentsTable,
  services as servicesTable,
} from "../db/schema/control-plane";
import { getCurrentUser } from "../auth";
import { nowIso } from "../ids";
import { requireActiveTeamId, requireCapability } from "../membership";
import { githubCommitUrl } from "../utils";
import { recordActivity } from "./activity";
import { startDeployment, destroyStack, rerouteService } from "../deploy/build";
import {
  loadDeployment,
  loadDeploymentsForService,
  serviceInTeam,
} from "./service-graph-load";
import { assembleDeployment } from "./service-graph-rows";
import { loadDeploymentLogs } from "./deployment-logs";
import { requireFolderCapabilityForService } from "./folder-access";
import type { Deployment, DeploymentEnvironment, LogLine } from "../types";

export async function listDeployments(filter?: {
  serviceId?: string;
  environment?: DeploymentEnvironment;
  status?: Deployment["status"];
}): Promise<
  (Deployment & {
    serviceName: string;
    serviceSlug: string;
    /** GitHub commit URL for this deployment's SHA, or null for a non-GitHub
     * source — lets a list decorate the SHA with a link without loading the
     * project graph. */
    commitUrl: string | null;
  })[]
> {
  const teamId = await requireActiveTeamId();
  // The caller's team services, by id (the deployment join target + the name/slug
  // decoration, plus the repo columns needed to build the commit link).
  const teamServices = await getDb()
    .select({
      id: servicesTable.id,
      name: servicesTable.name,
      slug: servicesTable.slug,
      repoProvider: servicesTable.repoProvider,
      repoRepo: servicesTable.repoRepo,
      repoUrl: servicesTable.repoUrl,
    })
    .from(servicesTable)
    .where(eq(servicesTable.teamId, teamId));
  const byId = new Map(teamServices.map((p) => [p.id, p] as const));
  const serviceIds = filter?.serviceId
    ? byId.has(filter.serviceId)
      ? [filter.serviceId]
      : []
    : teamServices.map((p) => p.id);
  if (serviceIds.length === 0) return [];

  // Newest-first with the deterministic seq tie-break, push-down into SQL.
  const rows = await getDb()
    .select()
    .from(deploymentsTable)
    .where(inArray(deploymentsTable.serviceId, serviceIds))
    .orderBy(desc(deploymentsTable.createdAt), desc(deploymentsTable.seq));

  return rows
    .map(assembleDeployment)
    .filter((x) => !filter?.environment || x.environment === filter.environment)
    .filter((x) => !filter?.status || x.status === filter.status)
    .map((x) => {
      const p = byId.get(x.serviceId);
      return {
        ...x,
        serviceName: p?.name ?? "",
        serviceSlug: p?.slug ?? "",
        commitUrl: githubCommitUrl(
          { provider: p?.repoProvider, repo: p?.repoRepo, url: p?.repoUrl },
          x.commitSha,
        ),
      };
    });
}

export async function getDeployment(id: string): Promise<Deployment | null> {
  const teamId = await requireActiveTeamId();
  const dep = await loadDeployment(id);
  if (!dep) return null;
  return (await serviceInTeam(dep.serviceId, teamId)) ? dep : null;
}

export async function getLogs(deploymentId: string): Promise<LogLine[]> {
  const teamId = await requireActiveTeamId();
  const dep = await loadDeployment(deploymentId);
  if (!dep) return [];
  if (!(await serviceInTeam(dep.serviceId, teamId))) return [];
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
export async function reloadService(
  serviceId: string,
): Promise<"rerouted" | "unchanged" | "deferred"> {
  const { membership } = await requireCapability("deploy");
  const user = (await getCurrentUser())!;
  if (!(await serviceInTeam(serviceId, membership.teamId)))
    throw new Error("Service not found");
  await requireFolderCapabilityForService(serviceId, "deploy");
  const result = await rerouteService(serviceId);
  if (result === "rerouted")
    await recordActivity("service", `Reloaded routing`, user.name, serviceId);
  return result;
}

/** Trigger a fresh production build + deploy of the latest commit. */
export async function redeploy(serviceId: string): Promise<Deployment> {
  const { membership } = await requireCapability("deploy");
  const user = (await getCurrentUser())!;
  if (!(await serviceInTeam(serviceId, membership.teamId)))
    throw new Error("Service not found");
  await requireFolderCapabilityForService(serviceId, "deploy");
  const depId = await startDeployment(serviceId, {
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
  if (!(await serviceInTeam(dep.serviceId, membership.teamId)))
    throw new Error("Deployment not found");
  await requireFolderCapabilityForService(dep.serviceId, "deploy");
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
  if (!(await serviceInTeam(existing.serviceId, membership.teamId)))
    throw new Error("Deployment not found");
  await requireFolderCapabilityForService(existing.serviceId, "deploy");
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
      .update(servicesTable)
      .set({
        latestDeploymentId: id,
        productionUrl: dep[0]!.url,
        updatedAt: nowIso(),
      })
      .where(eq(servicesTable.id, dep[0]!.serviceId));
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
 * push-down so the GraphQL `Service.deployments` resolver doesn't load the whole
 * history into memory.
 */
export async function listServiceDeployments(
  serviceId: string,
  opts: { limit?: number } = {},
): Promise<Deployment[]> {
  return loadDeploymentsForService(serviceId, opts);
}

/**
 * Tear down a project's running stack (used when deleting the project). Returns
 * `true` if the stack was destroyed, `false` if teardown failed — for a REMOTE
 * project that means an unreachable agent, in which case the delete proceeds
 * anyway (P6 spirit) and the caller warns that leftover containers on the remote
 * must be cleaned by hand. Never throws, so a dead remote never blocks a delete.
 */
export async function teardownService(slug: string): Promise<boolean> {
  try {
    await destroyStack(slug);
    return true;
  } catch {
    return false;
  }
}
