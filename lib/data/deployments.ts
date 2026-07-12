import "server-only";

import { and, desc, eq, inArray, notInArray } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  deployments as deploymentsTable,
  services as servicesTable,
} from "../db/schema/control-plane";
import { getCurrentUser } from "../auth";
import { nowIso } from "../ids";
import { requireActiveTeamId, requireCapability } from "../membership";
import { githubCommitUrl } from "../utils";
import { publishServiceChanged } from "../graphql/pubsub";
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

/**
 * Stop a queued/building deployment. Flips the row to `canceled`; the running
 * build job (fire-and-forget, no agent-side abort) keeps going, but its terminal
 * write honors this flag — `settleIfCanceled` in build.ts never overwrites a
 * canceled row back to ready/error and settles the service off "building". The
 * in-progress build on the host may still finish in the background; its result is
 * simply not deployed. Truly killing that host build needs a new agent RPC.
 *
 * Returns whether a build was actually stopped — `false` when it had already
 * finished (0 rows), so the caller can avoid a misleading "Build stopped" toast.
 */
export async function cancelDeployment(id: string): Promise<boolean> {
  const { membership } = await requireCapability("deploy");
  const user = (await getCurrentUser())!;
  const dep = await loadDeployment(id);
  if (!dep) throw new Error("Deployment not found");
  if (!(await serviceInTeam(dep.serviceId, membership.teamId)))
    throw new Error("Deployment not found");
  await requireFolderCapabilityForService(dep.serviceId, "deploy");
  // The queued/building state is part of the WHERE, not just a pre-check: a build
  // that finished between the read above and this write must NOT be retroactively
  // flipped from ready/error to canceled (0 rows → no-op).
  const stopped = await getDb()
    .update(deploymentsTable)
    .set({ status: "canceled" })
    .where(
      and(
        eq(deploymentsTable.id, id),
        inArray(deploymentsTable.status, ["queued", "building"]),
      ),
    )
    .returning({ id: deploymentsTable.id });
  if (stopped.length === 0) return false;
  // Push the "Canceled" status to live subscribers so the badge flips at once,
  // without waiting for the build job to notice and settle the service.
  publishServiceChanged(dep.serviceId);
  await recordActivity(
    "deployment",
    "Stopped a running build",
    user.name,
    dep.serviceId,
  );
  return true;
}

/**
 * A deployment is "in progress" while it sits in the queue or is being built —
 * its row is still referenced by the deploy queue and the fire-and-forget build
 * job, so it must be CANCELED (see `cancelDeployment`), not deleted. Everything
 * else (`ready` / `error` / `canceled`) is terminal history and safe to remove.
 */
const IN_PROGRESS: Deployment["status"][] = ["queued", "building"];

/** Terminal (deletable) deployment rows for the team, optionally narrowed to a
 *  set of ids or a single service. Joined through `services` so a foreign/stale
 *  id is simply absent (team isolation). */
async function terminalDeploymentRows(
  teamId: string,
  filter: { ids?: string[]; serviceId?: string },
): Promise<{ id: string; serviceId: string }[]> {
  const conds = [
    eq(servicesTable.teamId, teamId),
    notInArray(deploymentsTable.status, IN_PROGRESS),
  ];
  if (filter.serviceId) conds.push(eq(deploymentsTable.serviceId, filter.serviceId));
  if (filter.ids) conds.push(inArray(deploymentsTable.id, filter.ids));
  return getDb()
    .select({ id: deploymentsTable.id, serviceId: deploymentsTable.serviceId })
    .from(deploymentsTable)
    .innerJoin(servicesTable, eq(deploymentsTable.serviceId, servicesTable.id))
    .where(and(...conds));
}

/** The actual delete: removes the rows (cascading their logs and NULLing any
 *  `latest_deployment_id` pointer via the FKs), nudges live subscribers, and logs
 *  one activity line. Returns how many rows were removed. */
async function removeDeploymentRows(
  rows: { id: string; serviceId: string }[],
  teamId: string,
  userName: string,
): Promise<number> {
  if (rows.length === 0) return 0;
  const deleted = await getDb()
    .delete(deploymentsTable)
    .where(inArray(deploymentsTable.id, rows.map((r) => r.id)))
    .returning({ id: deploymentsTable.id, serviceId: deploymentsTable.serviceId });
  const services = new Set(deleted.map((d) => d.serviceId));
  // Deleting the latest deployment NULLs the service's pointer (FK set-null), so
  // the live status/latest-deployment reads must refresh.
  for (const sid of services) publishServiceChanged(sid);
  if (deleted.length > 0)
    await recordActivity(
      "deployment",
      `Deleted ${deleted.length} deployment${deleted.length === 1 ? "" : "s"}`,
      userName,
      services.size === 1 ? [...services][0]! : null,
      teamId,
    );
  return deleted.length;
}

/** True if the caller may `deploy` on the service's folder (top-level ⇒ team caps
 *  already suffice). Non-throwing companion to `requireFolderCapabilityForService`,
 *  for the broad "delete all" sweep where a locked folder is skipped, not fatal. */
async function mayManageServiceFolder(serviceId: string): Promise<boolean> {
  try {
    await requireFolderCapabilityForService(serviceId, "deploy");
    return true;
  } catch {
    return false;
  }
}

/**
 * Delete finished deployments by id (the multi-select "Delete selected"). Only
 * terminal rows are removed; any in-progress id in the selection is left for the
 * caller to cancel first. Team-scoped, and — like `moveServicesToFolder` — it
 * requires `deploy` on each distinct service's folder, throwing on one the caller
 * can't manage. Returns how many were actually deleted.
 */
export async function deleteDeployments(ids: string[]): Promise<number> {
  const { membership } = await requireCapability("deploy");
  const user = (await getCurrentUser())!;
  const unique = [...new Set(ids)];
  if (unique.length === 0) return 0;
  const rows = await terminalDeploymentRows(membership.teamId, { ids: unique });
  if (rows.length === 0) return 0;
  for (const sid of new Set(rows.map((r) => r.serviceId)))
    await requireFolderCapabilityForService(sid, "deploy");
  return removeDeploymentRows(rows, membership.teamId, user.name);
}

/**
 * Delete EVERY finished deployment — for one service (`serviceId` given, the
 * service page's "Delete all") or across the whole active team (`serviceId`
 * null/absent, the global page's "Delete all"). The single-service form enforces
 * folder `deploy` (throws if the caller can't manage it); the team-wide sweep
 * SKIPS services whose folder the caller can't manage rather than failing whole,
 * so one locked folder never blocks clearing the rest. In-progress deployments
 * are always left. Returns how many were deleted.
 */
export async function deleteAllDeployments(
  serviceId?: string | null,
): Promise<number> {
  const { membership } = await requireCapability("deploy");
  const user = (await getCurrentUser())!;
  if (serviceId) {
    if (!(await serviceInTeam(serviceId, membership.teamId)))
      throw new Error("Service not found");
    await requireFolderCapabilityForService(serviceId, "deploy");
    const rows = await terminalDeploymentRows(membership.teamId, { serviceId });
    return removeDeploymentRows(rows, membership.teamId, user.name);
  }
  const rows = await terminalDeploymentRows(membership.teamId, {});
  const allowed = new Map<string, boolean>();
  const permitted: { id: string; serviceId: string }[] = [];
  for (const r of rows) {
    if (!allowed.has(r.serviceId))
      allowed.set(r.serviceId, await mayManageServiceFolder(r.serviceId));
    if (allowed.get(r.serviceId)) permitted.push(r);
  }
  return removeDeploymentRows(permitted, membership.teamId, user.name);
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
