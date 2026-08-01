import "server-only";

import { and, asc, desc, eq, inArray, notInArray, sql } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  deployments as deploymentsTable,
  apps as appsTable,
  servers as serversTable,
} from "../db/schema/control-plane";
import { getCurrentUser } from "../auth";
import { nowIso } from "../ids";
import { requireActiveTeamId, requireCapability } from "../membership";
import { githubCommitUrl } from "../utils";
import { publishAppChanged } from "../graphql/pubsub";
import { recordActivity } from "./activity";
import { startDeployment, destroyStack, rerouteApp } from "../deploy/build";
import {
  loadDeployment,
  loadDeploymentsForApp,
  appInTeam,
} from "./app-graph-load";
import { assembleDeployment } from "./app-graph-rows";
import { loadDeploymentLogs } from "./deployment-logs";
import { requireFolderCapabilityForApp } from "./folder-access";
import type { Deployment, DeploymentEnvironment, LogLine } from "../types";

export async function listDeployments(filter?: {
  appId?: string;
  environment?: DeploymentEnvironment;
  status?: Deployment["status"];
  /** Cap the number of rows (newest-first). Bounds the nested GraphQL fan-out
   * (App.deployments) so a small query can't force loading every deployment. */
  limit?: number;
}): Promise<
  (Deployment & {
    serviceName: string;
    appSlug: string;
    /** GitHub commit URL for this deployment's SHA, or null for a non-GitHub
     * source — lets a list decorate the SHA with a link without loading the
     * project graph. */
    commitUrl: string | null;
    /** Owning server of the deployment — the host it ran on (`deployments.server_id`,
     *  denormalized) falling back to the app's current server. null only when
     *  neither is set (a legacy row on an app with no resolvable server). */
    serverId: string | null;
    /** Display name of {@link serverId}, or null when it can't be resolved. */
    serverName: string | null;
  })[]
> {
  const teamId = await requireActiveTeamId();
  // The caller's team apps, by id (the deployment join target + the name/slug
  // decoration, the owning server for the server column, plus the repo columns
  // needed to build the commit link).
  const teamApps = await getDb()
    .select({
      id: appsTable.id,
      name: appsTable.name,
      slug: appsTable.slug,
      serverId: appsTable.serverId,
      repoProvider: appsTable.repoProvider,
      repoRepo: appsTable.repoRepo,
      repoUrl: appsTable.repoUrl,
    })
    .from(appsTable)
    .where(eq(appsTable.teamId, teamId));
  const byId = new Map(teamApps.map((p) => [p.id, p] as const));
  const appIds = filter?.appId
    ? byId.has(filter.appId)
      ? [filter.appId]
      : []
    : teamApps.map((p) => p.id);
  if (appIds.length === 0) return [];

  // Newest-first with the deterministic seq tie-break, push-down into SQL.
  const base = getDb()
    .select()
    .from(deploymentsTable)
    .where(inArray(deploymentsTable.appId, appIds))
    .orderBy(desc(deploymentsTable.createdAt), desc(deploymentsTable.seq));
  const rows = await (filter?.limit != null ? base.limit(filter.limit) : base);

  // Resolve owning-server NAMES for the "Server" column / filter. A deployment's
  // own `serverId` is the host it ran on (may be null on legacy rows) — fall back
  // to the app's current server. Names are looked up by id: servers aren't
  // team-scoped, but we only resolve ids the team's own rows already reference, so
  // this leaks nothing (a team can't conjure a server id it never deployed on).
  const serverIds = [
    ...new Set(
      [
        ...rows.map((r) => r.serverId),
        ...teamApps.map((s) => s.serverId),
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
      const p = byId.get(dep.appId);
      const serverId = rowServerId ?? p?.serverId ?? null;
      return {
        ...dep,
        serviceName: p?.name ?? "",
        appSlug: p?.slug ?? "",
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
  return (await appInTeam(dep.appId, teamId)) ? dep : null;
}

export async function getLogs(deploymentId: string): Promise<LogLine[]> {
  const teamId = await requireActiveTeamId();
  const dep = await loadDeployment(deploymentId);
  if (!dep) return [];
  if (!(await appInTeam(dep.appId, teamId))) return [];
  return loadDeploymentLogs(deploymentId);
}

/**
 * 1-based position of a `queued` deployment in its owning server's build queue,
 * or null when it isn't queued (already building/terminal) or isn't the active
 * team's. Position 1 = next to build.
 *
 * Mirrors the deploy queue's drain order exactly (see {@link ../deploy/deploy-queue}
 * `pickNext`): per OWNING SERVER, oldest-first by `(createdAt, seq)`, where the
 * effective server is the row's denormalized `serverId` or the app's when that's
 * null — the same `coalesce` the cancel sweep uses. So the number the UI shows is
 * the order the queue will actually drain in. It counts only the queued rows
 * ahead, NOT whatever is currently `building`: position 1 means "next queued", so
 * it starts as soon as a build slot on the server frees. Recomputed on every read
 * (not cached), so a live poll watches it shrink as the builds ahead finish.
 */
export async function getQueuePosition(
  deploymentId: string,
): Promise<number | null> {
  const teamId = await requireActiveTeamId();
  const [target] = await getDb()
    .select({
      appId: deploymentsTable.appId,
      status: deploymentsTable.status,
      // Effective owning server: the row's own, else the app's (queue is per-server).
      serverId: sql<
        string | null
      >`coalesce(${deploymentsTable.serverId}, ${appsTable.serverId})`,
    })
    .from(deploymentsTable)
    .innerJoin(appsTable, eq(deploymentsTable.appId, appsTable.id))
    .where(eq(deploymentsTable.id, deploymentId))
    .limit(1);
  if (!target) return null;
  if (!(await appInTeam(target.appId, teamId))) return null;
  if (target.status !== "queued" || !target.serverId) return null;

  // The queued backlog for this server, oldest-first — the SAME rows and order
  // `pickNext` scans. This deployment's 1-based slot in it is its queue position.
  const queued = await getDb()
    .select({ id: deploymentsTable.id })
    .from(deploymentsTable)
    .innerJoin(appsTable, eq(deploymentsTable.appId, appsTable.id))
    .where(
      and(
        eq(deploymentsTable.status, "queued"),
        sql`coalesce(${deploymentsTable.serverId}, ${appsTable.serverId}) = ${target.serverId}`,
      ),
    )
    .orderBy(asc(deploymentsTable.createdAt), asc(deploymentsTable.seq));
  const idx = queued.findIndex((r) => r.id === deploymentId);
  return idx === -1 ? null : idx + 1;
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
export async function reloadApp(
  appId: string,
): Promise<"rerouted" | "unchanged" | "deferred"> {
  const { membership } = await requireCapability("deploy");
  const user = (await getCurrentUser())!;
  if (!(await appInTeam(appId, membership.teamId)))
    throw new Error("App not found");
  await requireFolderCapabilityForApp(appId, "deploy");
  const result = await rerouteApp(appId);
  if (result === "rerouted")
    await recordActivity("app", `Reloaded routing`, user.name, appId);
  return result;
}

/** Trigger a fresh production build + deploy of the latest commit. */
export async function redeploy(appId: string): Promise<Deployment> {
  const { membership } = await requireCapability("deploy");
  const user = (await getCurrentUser())!;
  if (!(await appInTeam(appId, membership.teamId)))
    throw new Error("App not found");
  await requireFolderCapabilityForApp(appId, "deploy");
  const depId = await startDeployment(appId, {
    environment: "production",
    creator: user.name,
    commitMessage: "Redeploy of latest commit",
  });
  return (await loadDeployment(depId))!;
}

/**
 * How long the build had been running, frozen onto a row at the moment it is
 * canceled. A build stopped after 12s reports 12s instead of a blank "Build
 * time" — the same number the page's live timer was showing when the button was
 * clicked, so stopping a build doesn't erase what it cost.
 *
 * Computed in SQL against `started_at` (not in JS against a value read earlier)
 * so it measures the row as it is at write time. Null-safe by construction: a
 * deployment canceled while still `queued` never started, so it keeps a null
 * duration — there is no build whose time we could claim to know.
 */
const elapsedBuildMs = sql`case when ${deploymentsTable.startedAt} is null then null else greatest(0, (extract(epoch from (now() - ${deploymentsTable.startedAt})) * 1000)::bigint) end`;

/**
 * Stop a queued/building deployment. Flips the row to `canceled` and settles the
 * app off "building" right away (see `settleAppAfterCancel`); the running
 * build job (fire-and-forget, no agent-side abort) keeps going, but its terminal
 * write honors this flag — `settleIfCanceled` in build.ts never overwrites a
 * canceled row back to ready/error. The in-progress build on the host may still
 * finish in the background; its result is simply not deployed. Truly killing that
 * host build needs a new agent RPC.
 *
 * Returns whether a build was actually stopped — `false` when it had already
 * finished (0 rows), so the caller can avoid a misleading "Build stopped" toast.
 */
export async function cancelDeployment(id: string): Promise<boolean> {
  const { membership } = await requireCapability("deploy");
  const user = (await getCurrentUser())!;
  const dep = await loadDeployment(id);
  if (!dep) throw new Error("Deployment not found");
  if (!(await appInTeam(dep.appId, membership.teamId)))
    throw new Error("Deployment not found");
  await requireFolderCapabilityForApp(dep.appId, "deploy");
  // The queued/building state is part of the WHERE, not just a pre-check: a build
  // that finished between the read above and this write must NOT be retroactively
  // flipped from ready/error to canceled (0 rows → no-op).
  const stopped = await getDb()
    .update(deploymentsTable)
    .set({ status: "canceled", buildDurationMs: elapsedBuildMs })
    .where(
      and(
        eq(deploymentsTable.id, id),
        inArray(deploymentsTable.status, ["queued", "building"]),
      ),
    )
    .returning({ id: deploymentsTable.id });
  if (stopped.length === 0) return false;
  // Settle the app off "building" NOW (before the publish), then push the
  // change so the badge flips to "Stopped" at once — without waiting for the build
  // job to notice and settle it minutes later.
  await settleAppAfterCancel(dep.appId);
  publishAppChanged(dep.appId);
  await recordActivity(
    "deployment",
    "Stopped a running build",
    user.name,
    dep.appId,
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
 *  server the list shows — the deployment's own `server_id`, or the app's when
 *  the row's is null — so filtering by a server on the deployments page and then
 *  sweeping it hits exactly the visible rows (including legacy rows with a null
 *  `deployments.server_id`). Both columns are in scope via the `apps` join. */
const onServer = (serverId: string) =>
  sql`coalesce(${deploymentsTable.serverId}, ${appsTable.serverId}) = ${serverId}`;

/** Terminal (deletable) deployment rows for the team, optionally narrowed to a
 *  set of ids, a single app, and/or a single owning server. Joined through
 *  `apps` so a foreign/stale id is simply absent (team isolation). */
async function terminalDeploymentRows(
  teamId: string,
  filter: {
    ids?: string[];
    appId?: string;
    serverId?: string;
    environment?: string;
    status?: string;
  },
): Promise<{ id: string; appId: string }[]> {
  const conds = [
    eq(appsTable.teamId, teamId),
    notInArray(deploymentsTable.status, IN_PROGRESS),
  ];
  if (filter.appId) conds.push(eq(deploymentsTable.appId, filter.appId));
  if (filter.serverId) conds.push(onServer(filter.serverId));
  if (filter.environment)
    conds.push(eq(deploymentsTable.environment, filter.environment));
  // A terminal-status narrower simply AND's with `notInArray(IN_PROGRESS)`, so an
  // in-progress value (queued/building) yields 0 rows — which is exactly right:
  // the "Delete all" button hides when the status filter shows only in-progress.
  if (filter.status) conds.push(eq(deploymentsTable.status, filter.status));
  if (filter.ids) conds.push(inArray(deploymentsTable.id, filter.ids));
  return getDb()
    .select({ id: deploymentsTable.id, appId: deploymentsTable.appId })
    .from(deploymentsTable)
    .innerJoin(appsTable, eq(deploymentsTable.appId, appsTable.id))
    .where(and(...conds));
}

/** The actual delete: removes the rows (cascading their logs and NULLing any
 *  `latest_deployment_id` pointer via the FKs), nudges live subscribers, and logs
 *  one activity line. Returns how many rows were removed. */
async function removeDeploymentRows(
  rows: { id: string; appId: string }[],
  teamId: string,
  userName: string,
): Promise<number> {
  if (rows.length === 0) return 0;
  const deleted = await getDb()
    .delete(deploymentsTable)
    .where(inArray(deploymentsTable.id, rows.map((r) => r.id)))
    .returning({ id: deploymentsTable.id, appId: deploymentsTable.appId });
  const apps = new Set(deleted.map((d) => d.appId));
  // Deleting the latest deployment NULLs the app's pointer (FK set-null), so
  // the live status/latest-deployment reads must refresh.
  for (const sid of apps) publishAppChanged(sid);
  if (deleted.length > 0)
    await recordActivity(
      "deployment",
      `Deleted ${deleted.length} deployment${deleted.length === 1 ? "" : "s"}`,
      userName,
      apps.size === 1 ? [...apps][0]! : null,
      teamId,
    );
  return deleted.length;
}

/** True if the caller may `deploy` on the app's folder (top-level ⇒ team caps
 *  already suffice). Non-throwing companion to `requireFolderCapabilityForApp`,
 *  for the broad "delete all" sweep where a locked folder is skipped, not fatal. */
async function mayManageAppFolder(appId: string): Promise<boolean> {
  try {
    await requireFolderCapabilityForApp(appId, "deploy");
    return true;
  } catch {
    return false;
  }
}

/**
 * Delete finished deployments by id (the multi-select "Delete selected"). Only
 * terminal rows are removed; any in-progress id in the selection is left for the
 * caller to cancel first. Team-scoped, and — like `moveAppsToFolder` — it
 * requires `deploy` on each distinct app's folder, throwing on one the caller
 * can't manage. Returns how many were actually deleted.
 */
export async function deleteDeployments(ids: string[]): Promise<number> {
  const { membership } = await requireCapability("deploy");
  const user = (await getCurrentUser())!;
  const unique = [...new Set(ids)];
  if (unique.length === 0) return 0;
  const rows = await terminalDeploymentRows(membership.teamId, { ids: unique });
  if (rows.length === 0) return 0;
  for (const sid of new Set(rows.map((r) => r.appId)))
    await requireFolderCapabilityForApp(sid, "deploy");
  return removeDeploymentRows(rows, membership.teamId, user.name);
}

/** Keep only rows whose app's folder the caller may `deploy` on — the
 *  team-wide-sweep guard shared by delete-all and cancel-all. SKIPS (rather than
 *  throws on) a locked folder so one never blocks clearing the rest, memoizing the
 *  per-app check. */
async function folderPermittedRows(
  rows: { id: string; appId: string }[],
): Promise<{ id: string; appId: string }[]> {
  const allowed = new Map<string, boolean>();
  const permitted: { id: string; appId: string }[] = [];
  for (const r of rows) {
    if (!allowed.has(r.appId))
      allowed.set(r.appId, await mayManageAppFolder(r.appId));
    if (allowed.get(r.appId)) permitted.push(r);
  }
  return permitted;
}

/**
 * Delete EVERY finished deployment — for one app (`appId` given, the
 * app page's "Delete all") or across the whole active team (`appId`
 * null/absent, the global page's "Delete all"). Optional `serverId` / `environment`
 * / `status` narrow the sweep to the deployments page's active view filters (owning
 * server, environment, and a specific terminal status), so a filtered "Delete all"
 * removes exactly the rows on screen. The single-app form enforces folder `deploy`
 * (throws if the caller can't manage it); the team-wide sweep SKIPS apps whose
 * folder the caller can't manage rather than failing whole, so one locked folder
 * never blocks clearing the rest. In-progress deployments are always left. Returns
 * how many were deleted.
 */
export async function deleteAllDeployments(
  appId?: string | null,
  serverId?: string | null,
  environment?: string | null,
  status?: string | null,
): Promise<number> {
  const { membership } = await requireCapability("deploy");
  const user = (await getCurrentUser())!;
  if (appId) {
    if (!(await appInTeam(appId, membership.teamId)))
      throw new Error("App not found");
    await requireFolderCapabilityForApp(appId, "deploy");
    const rows = await terminalDeploymentRows(membership.teamId, {
      appId,
      serverId: serverId ?? undefined,
      environment: environment ?? undefined,
      status: status ?? undefined,
    });
    return removeDeploymentRows(rows, membership.teamId, user.name);
  }
  const rows = await terminalDeploymentRows(membership.teamId, {
    serverId: serverId ?? undefined,
    environment: environment ?? undefined,
    status: status ?? undefined,
  });
  const permitted = await folderPermittedRows(rows);
  return removeDeploymentRows(permitted, membership.teamId, user.name);
}

/** In-progress (queued/building) deployment rows for the team, optionally narrowed
 *  to one app and/or one owning server. Mirror of `terminalDeploymentRows` for
 *  the cancel sweep; joined through `apps` so a foreign/stale id is simply
 *  absent (team isolation). */
async function inProgressDeploymentRows(
  teamId: string,
  filter: {
    appId?: string;
    serverId?: string;
    environment?: string;
    status?: string;
  },
): Promise<{ id: string; appId: string }[]> {
  const conds = [
    eq(appsTable.teamId, teamId),
    inArray(deploymentsTable.status, IN_PROGRESS),
  ];
  if (filter.appId) conds.push(eq(deploymentsTable.appId, filter.appId));
  if (filter.serverId) conds.push(onServer(filter.serverId));
  if (filter.environment)
    conds.push(eq(deploymentsTable.environment, filter.environment));
  // Narrows WITHIN the in-progress set, so a terminal-status value (ready/error/
  // canceled) yields 0 rows — matching the hidden "Stop all builds" button when the
  // status filter shows only finished deployments.
  if (filter.status) conds.push(eq(deploymentsTable.status, filter.status));
  return getDb()
    .select({ id: deploymentsTable.id, appId: deploymentsTable.appId })
    .from(deploymentsTable)
    .innerJoin(appsTable, eq(deploymentsTable.appId, appsTable.id))
    .where(and(...conds));
}

/**
 * Settle an app off the in-progress states the instant its build is canceled.
 * The app is flipped to `building`/`queued` at deploy time (build.ts) and only
 * settled back when the fire-and-forget build job finally reaches `markStopped` —
 * which can be minutes away, so until then the live badge lies "building" even
 * though the deployment already reads `canceled`. Flip it to `idle` ("Stopped")
 * now, matching that eventual outcome. Guarded two ways so it never overreaches:
 * only when the app has NO other queued/building deployment left (a superseding
 * build keeps it going) and only FROM `building`/`queued` (never clobbering a
 * running/errored/idle app). No publish here — the caller emits one snapshot
 * after settling so subscribers paint the settled status.
 */
async function settleAppAfterCancel(appId: string): Promise<void> {
  const remaining = await getDb()
    .select({ id: deploymentsTable.id })
    .from(deploymentsTable)
    .where(
      and(
        eq(deploymentsTable.appId, appId),
        inArray(deploymentsTable.status, IN_PROGRESS),
      ),
    )
    .limit(1);
  if (remaining.length > 0) return;
  await getDb()
    .update(appsTable)
    .set({ status: "idle", updatedAt: nowIso() })
    .where(
      and(
        eq(appsTable.id, appId),
        inArray(appsTable.status, ["building", "queued"]),
      ),
    );
}

/** Flip the given in-progress rows to `canceled` (same semantics as the single
 *  `cancelDeployment`: the host build may finish in the background, its result just
 *  isn't deployed). The `status IN (queued, building)` guard stays in the WHERE —
 *  not just the read above — so a build that settled to ready/error in the gap is
 *  never retroactively flipped to canceled (it drops out at 0 rows). Settles each
 *  affected app off "building", nudges live subscribers so each badge flips at
 *  once, and logs one activity line. Returns how many were actually stopped. */
async function cancelDeploymentRows(
  rows: { id: string; appId: string }[],
  teamId: string,
  userName: string,
): Promise<number> {
  if (rows.length === 0) return 0;
  const stopped = await getDb()
    .update(deploymentsTable)
    .set({ status: "canceled", buildDurationMs: elapsedBuildMs })
    .where(
      and(
        inArray(deploymentsTable.id, rows.map((r) => r.id)),
        inArray(deploymentsTable.status, IN_PROGRESS),
      ),
    )
    .returning({ id: deploymentsTable.id, appId: deploymentsTable.appId });
  const apps = new Set(stopped.map((d) => d.appId));
  // Settle each app BEFORE publishing so the emitted snapshot carries the
  // settled status, not the stale "building".
  for (const sid of apps) await settleAppAfterCancel(sid);
  for (const sid of apps) publishAppChanged(sid);
  if (stopped.length > 0)
    await recordActivity(
      "deployment",
      `Stopped ${stopped.length} running build${stopped.length === 1 ? "" : "s"}`,
      userName,
      apps.size === 1 ? [...apps][0]! : null,
      teamId,
    );
  return stopped.length;
}

/**
 * Cancel EVERY in-progress deployment — for one app (`appId` given, the
 * app page's "Stop all builds") or across the whole active team (`appId`
 * null/absent, the global page's "Stop all builds"). Optional `serverId` /
 * `environment` / `status` narrow the sweep to the deployments page's active view
 * filters (owning server, environment, and a specific in-progress status), so a
 * filtered "Stop all builds" stops exactly the builds on screen. The counterpart to
 * `deleteAllDeployments`: same folder-`deploy` rules (single-app throws if the
 * caller can't manage that folder; the team-wide sweep SKIPS folders it can't manage
 * rather than failing whole) but it flips queued/building rows to `canceled` instead
 * of deleting terminal ones. Terminal deployments are always left. Returns how many
 * builds were actually stopped.
 */
export async function cancelAllDeployments(
  appId?: string | null,
  serverId?: string | null,
  environment?: string | null,
  status?: string | null,
): Promise<number> {
  const { membership } = await requireCapability("deploy");
  const user = (await getCurrentUser())!;
  if (appId) {
    if (!(await appInTeam(appId, membership.teamId)))
      throw new Error("App not found");
    await requireFolderCapabilityForApp(appId, "deploy");
    const rows = await inProgressDeploymentRows(membership.teamId, {
      appId,
      serverId: serverId ?? undefined,
      environment: environment ?? undefined,
      status: status ?? undefined,
    });
    return cancelDeploymentRows(rows, membership.teamId, user.name);
  }
  const rows = await inProgressDeploymentRows(membership.teamId, {
    serverId: serverId ?? undefined,
    environment: environment ?? undefined,
    status: status ?? undefined,
  });
  const permitted = await folderPermittedRows(rows);
  return cancelDeploymentRows(permitted, membership.teamId, user.name);
}

export async function promoteToProduction(id: string): Promise<void> {
  const { membership } = await requireCapability("deploy");
  const user = (await getCurrentUser())!;
  const existing = await loadDeployment(id);
  if (!existing) throw new Error("Deployment not found");
  if (!(await appInTeam(existing.appId, membership.teamId)))
    throw new Error("Deployment not found");
  await requireFolderCapabilityForApp(existing.appId, "deploy");
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
      .update(appsTable)
      .set({
        latestDeploymentId: id,
        productionUrl: dep[0]!.url,
        updatedAt: nowIso(),
      })
      .where(eq(appsTable.id, dep[0]!.appId));
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
 * push-down so the GraphQL `App.deployments` resolver doesn't load the whole
 * history into memory.
 */
export async function listAppDeployments(
  appId: string,
  opts: { limit?: number } = {},
): Promise<Deployment[]> {
  return loadDeploymentsForApp(appId, opts);
}

/**
 * Tear down a project's running stack (used when deleting the project). Returns
 * `true` if the stack was destroyed, `false` if teardown failed — for a REMOTE
 * project that means an unreachable agent, in which case the delete proceeds
 * anyway (P6 spirit) and the caller warns that leftover containers on the remote
 * must be cleaned by hand. Never throws, so a dead remote never blocks a delete.
 */
export async function teardownApp(slug: string): Promise<boolean> {
  try {
    await destroyStack(slug);
    return true;
  } catch {
    return false;
  }
}
