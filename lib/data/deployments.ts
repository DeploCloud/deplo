import "server-only";

import { and, desc, eq, inArray, notInArray, sql } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  deployments as deploymentsTable,
  services as servicesTable,
  servers as serversTable,
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
    /** Owning server of the deployment — the host it ran on (`deployments.server_id`,
     *  denormalized) falling back to the service's current server. null only when
     *  neither is set (a legacy row on a service with no resolvable server). */
    serverId: string | null;
    /** Display name of {@link serverId}, or null when it can't be resolved. */
    serverName: string | null;
  })[]
> {
  const teamId = await requireActiveTeamId();
  // The caller's team services, by id (the deployment join target + the name/slug
  // decoration, the owning server for the server column, plus the repo columns
  // needed to build the commit link).
  const teamServices = await getDb()
    .select({
      id: servicesTable.id,
      name: servicesTable.name,
      slug: servicesTable.slug,
      serverId: servicesTable.serverId,
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

  // Resolve owning-server NAMES for the "Server" column / filter. A deployment's
  // own `serverId` is the host it ran on (may be null on legacy rows) — fall back
  // to the service's current server. Names are looked up by id: servers aren't
  // team-scoped, but we only resolve ids the team's own rows already reference, so
  // this leaks nothing (a team can't conjure a server id it never deployed on).
  const serverIds = [
    ...new Set(
      [
        ...rows.map((r) => r.serverId),
        ...teamServices.map((s) => s.serverId),
      ].filter((id): id is string => !!id),
    ),
  ];
  const serverNameById = new Map(
    serverIds.length === 0
      ? []
      : (
          await getDb()
            .select({ id: serversTable.id, name: serversTable.name })
            .from(serversTable)
            .where(inArray(serversTable.id, serverIds))
        ).map((s) => [s.id, s.name] as const),
  );

  return rows
    .map((row) => ({ dep: assembleDeployment(row), rowServerId: row.serverId }))
    .filter(({ dep }) => !filter?.environment || dep.environment === filter.environment)
    .filter(({ dep }) => !filter?.status || dep.status === filter.status)
    .map(({ dep, rowServerId }) => {
      const p = byId.get(dep.serviceId);
      const serverId = rowServerId ?? p?.serverId ?? null;
      return {
        ...dep,
        serviceName: p?.name ?? "",
        serviceSlug: p?.slug ?? "",
        serverId,
        serverName: serverId ? (serverNameById.get(serverId) ?? null) : null,
        commitUrl: githubCommitUrl(
          { provider: p?.repoProvider, repo: p?.repoRepo, url: p?.repoUrl },
          dep.commitSha,
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

/** Narrow a deployment sweep to one owning server. Matches the SAME effective
 *  server the list shows — the deployment's own `server_id`, or the service's when
 *  the row's is null — so filtering by a server on the deployments page and then
 *  sweeping it hits exactly the visible rows (including legacy rows with a null
 *  `deployments.server_id`). Both columns are in scope via the `services` join. */
const onServer = (serverId: string) =>
  sql`coalesce(${deploymentsTable.serverId}, ${servicesTable.serverId}) = ${serverId}`;

/** Terminal (deletable) deployment rows for the team, optionally narrowed to a
 *  set of ids, a single service, and/or a single owning server. Joined through
 *  `services` so a foreign/stale id is simply absent (team isolation). */
async function terminalDeploymentRows(
  teamId: string,
  filter: { ids?: string[]; serviceId?: string; serverId?: string },
): Promise<{ id: string; serviceId: string }[]> {
  const conds = [
    eq(servicesTable.teamId, teamId),
    notInArray(deploymentsTable.status, IN_PROGRESS),
  ];
  if (filter.serviceId) conds.push(eq(deploymentsTable.serviceId, filter.serviceId));
  if (filter.serverId) conds.push(onServer(filter.serverId));
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

/** Keep only rows whose service's folder the caller may `deploy` on — the
 *  team-wide-sweep guard shared by delete-all and cancel-all. SKIPS (rather than
 *  throws on) a locked folder so one never blocks clearing the rest, memoizing the
 *  per-service check. */
async function folderPermittedRows(
  rows: { id: string; serviceId: string }[],
): Promise<{ id: string; serviceId: string }[]> {
  const allowed = new Map<string, boolean>();
  const permitted: { id: string; serviceId: string }[] = [];
  for (const r of rows) {
    if (!allowed.has(r.serviceId))
      allowed.set(r.serviceId, await mayManageServiceFolder(r.serviceId));
    if (allowed.get(r.serviceId)) permitted.push(r);
  }
  return permitted;
}

/**
 * Delete EVERY finished deployment — for one service (`serviceId` given, the
 * service page's "Delete all") or across the whole active team (`serviceId`
 * null/absent, the global page's "Delete all"). An optional `serverId` narrows the
 * sweep to one owning server (the deployments page's server filter). The
 * single-service form enforces folder `deploy` (throws if the caller can't manage
 * it); the team-wide sweep SKIPS services whose folder the caller can't manage
 * rather than failing whole, so one locked folder never blocks clearing the rest.
 * In-progress deployments are always left. Returns how many were deleted.
 */
export async function deleteAllDeployments(
  serviceId?: string | null,
  serverId?: string | null,
): Promise<number> {
  const { membership } = await requireCapability("deploy");
  const user = (await getCurrentUser())!;
  if (serviceId) {
    if (!(await serviceInTeam(serviceId, membership.teamId)))
      throw new Error("Service not found");
    await requireFolderCapabilityForService(serviceId, "deploy");
    const rows = await terminalDeploymentRows(membership.teamId, {
      serviceId,
      serverId: serverId ?? undefined,
    });
    return removeDeploymentRows(rows, membership.teamId, user.name);
  }
  const rows = await terminalDeploymentRows(membership.teamId, {
    serverId: serverId ?? undefined,
  });
  const permitted = await folderPermittedRows(rows);
  return removeDeploymentRows(permitted, membership.teamId, user.name);
}

/** In-progress (queued/building) deployment rows for the team, optionally narrowed
 *  to one service and/or one owning server. Mirror of `terminalDeploymentRows` for
 *  the cancel sweep; joined through `services` so a foreign/stale id is simply
 *  absent (team isolation). */
async function inProgressDeploymentRows(
  teamId: string,
  filter: { serviceId?: string; serverId?: string },
): Promise<{ id: string; serviceId: string }[]> {
  const conds = [
    eq(servicesTable.teamId, teamId),
    inArray(deploymentsTable.status, IN_PROGRESS),
  ];
  if (filter.serviceId) conds.push(eq(deploymentsTable.serviceId, filter.serviceId));
  if (filter.serverId) conds.push(onServer(filter.serverId));
  return getDb()
    .select({ id: deploymentsTable.id, serviceId: deploymentsTable.serviceId })
    .from(deploymentsTable)
    .innerJoin(servicesTable, eq(deploymentsTable.serviceId, servicesTable.id))
    .where(and(...conds));
}

/** Flip the given in-progress rows to `canceled` (same semantics as the single
 *  `cancelDeployment`: the host build may finish in the background, its result just
 *  isn't deployed). The `status IN (queued, building)` guard stays in the WHERE —
 *  not just the read above — so a build that settled to ready/error in the gap is
 *  never retroactively flipped to canceled (it drops out at 0 rows). Nudges live
 *  subscribers so each badge flips at once, and logs one activity line. Returns how
 *  many were actually stopped. */
async function cancelDeploymentRows(
  rows: { id: string; serviceId: string }[],
  teamId: string,
  userName: string,
): Promise<number> {
  if (rows.length === 0) return 0;
  const stopped = await getDb()
    .update(deploymentsTable)
    .set({ status: "canceled" })
    .where(
      and(
        inArray(deploymentsTable.id, rows.map((r) => r.id)),
        inArray(deploymentsTable.status, IN_PROGRESS),
      ),
    )
    .returning({ id: deploymentsTable.id, serviceId: deploymentsTable.serviceId });
  const services = new Set(stopped.map((d) => d.serviceId));
  for (const sid of services) publishServiceChanged(sid);
  if (stopped.length > 0)
    await recordActivity(
      "deployment",
      `Stopped ${stopped.length} running build${stopped.length === 1 ? "" : "s"}`,
      userName,
      services.size === 1 ? [...services][0]! : null,
      teamId,
    );
  return stopped.length;
}

/**
 * Cancel EVERY in-progress deployment — for one service (`serviceId` given, the
 * service page's "Stop all builds") or across the whole active team (`serviceId`
 * null/absent, the global page's "Stop all builds"). An optional `serverId` narrows
 * the sweep to one owning server (the deployments page's server filter). The
 * counterpart to `deleteAllDeployments`: same folder-`deploy` rules (single-service
 * throws if the caller can't manage that folder; the team-wide sweep SKIPS folders
 * it can't manage rather than failing whole) but it flips queued/building rows to
 * `canceled` instead of deleting terminal ones. Terminal deployments are always
 * left. Returns how many builds were actually stopped.
 */
export async function cancelAllDeployments(
  serviceId?: string | null,
  serverId?: string | null,
): Promise<number> {
  const { membership } = await requireCapability("deploy");
  const user = (await getCurrentUser())!;
  if (serviceId) {
    if (!(await serviceInTeam(serviceId, membership.teamId)))
      throw new Error("Service not found");
    await requireFolderCapabilityForService(serviceId, "deploy");
    const rows = await inProgressDeploymentRows(membership.teamId, {
      serviceId,
      serverId: serverId ?? undefined,
    });
    return cancelDeploymentRows(rows, membership.teamId, user.name);
  }
  const rows = await inProgressDeploymentRows(membership.teamId, {
    serverId: serverId ?? undefined,
  });
  const permitted = await folderPermittedRows(rows);
  return cancelDeploymentRows(permitted, membership.teamId, user.name);
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
