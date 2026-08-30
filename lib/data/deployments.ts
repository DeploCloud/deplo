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
import {
  requireActiveTeamId,
  requireCapability,
  requireMembership,
} from "../membership";
import {
  repoCommitUrl,
  githubPullRequestUrl,
  gitProfileUrl,
  appBuildsItsOwnImage,
} from "../utils";
import { publishAppChanged } from "../graphql/pubsub";
import { recordActivity } from "./activity";
import { startDeployment, destroyStack, rerouteApp } from "../deploy/build";
import {
  loadDeployment,
  loadDeploymentsForApp,
  appInTeam,
  appSourceInTeam,
  appScopeWhere,
} from "./app-graph-load";
import { assembleDeployment } from "./app-graph-rows";
import { authorOf, loadUserIdentities } from "./user-identity";
import { loadDeploymentLogs } from "./deployment-logs";
import {
  appCapabilities,
  appCapabilitiesForTeam,
  nodeCapabilitiesFor,
  hasAppCapability,
  requireAppCapability,
} from "./node-access";
import type {
  Deployment,
  DeploymentEnvironment,
  DeploySource,
  LogLine,
} from "../types";

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
    /** The app's display logo, so a cross-app list can show which app a row
     * belongs to without a second query. Null ⇒ the caller draws its own glyph. */
    appLogo: string | null;
    /** GitHub commit URL for this deployment's SHA, or null for a non-GitHub
     * source - lets a list decorate the SHA with a link without loading the
     * project graph. */
    commitUrl: string | null;
    /** GitHub URL of the pull request this preview build came from, or null for
     *  a production build. Derived from the denormalized `prNumber`, so it keeps
     *  working after the preview row itself is reaped. */
    pullRequestUrl: string | null;
    /** The git-host profile of the account that pushed, for a webhook build.
     *  Null for a deployment somebody here ran, and for a login we can't link. */
    creatorUrl: string | null;
    /** Owning server of the deployment - the host it ran on (`deployments.server_id`,
     *  denormalized) falling back to the app's current server. null only when
     *  neither is set (a legacy row on an app with no resolvable server). */
    serverId: string | null;
    /** Display name of {@link serverId}, or null when it can't be resolved. */
    serverName: string | null;
    /** Display name of the server this deploy BUILT on, when that was not
     *  {@link serverId}. Null for the ordinary "built where it runs". */
    buildServerName: string | null;
    /** This deployment can be rolled back to - see {@link rollbackTargetIds}.
     *  Decided HERE, never in the UI: whether an image is still on the host is a
     *  server fact, and a client re-deriving it would drift from the gate. */
    canRollback: boolean;
  })[]
> {
  const teamId = await requireActiveTeamId();
  // The caller's team apps, by id (the deployment join target + the name/slug
  // decoration, the owning server for the server column, plus the repo columns
  // needed to build the commit link).
  const scopedApps = await getDb()
    .select({
      id: appsTable.id,
      name: appsTable.name,
      slug: appsTable.slug,
      logo: appsTable.logo,
      serverId: appsTable.serverId,
      // Rollback eligibility: the retention depth, plus the four columns that say
      // whether this app builds an image of its own at all (see rollbackTargetIds).
      rollbackKeep: appsTable.rollbackKeep,
      source: appsTable.source,
      compose: appsTable.compose,
      dockerImage: appsTable.dockerImage,
      folderId: appsTable.folderId,
      projectId: appsTable.projectId,
      environmentId: appsTable.environmentId,
      repoProvider: appsTable.repoProvider,
      repoRepo: appsTable.repoRepo,
      repoUrl: appsTable.repoUrl,
    })
    .from(appsTable)
    .where(and(eq(appsTable.teamId, teamId), appScopeWhere()));
  // A deployment names its app, its commit and its URL, so an app the caller
  // can't reach (one inside a folder they can't see) must not appear here
  // either. One batched resolution for the team, not one per app.
  const reach = await appCapabilitiesForTeam(
    teamId,
    scopedApps.map((p) => ({
      id: p.id,
      folderId: p.folderId ?? null,
      projectId: p.projectId ?? null,
      environmentId: p.environmentId ?? null,
    })),
  );
  // A narrowed principal is NOT exempt.
  const teamApps = scopedApps.filter((p) => (reach.get(p.id)?.length ?? 0) > 0);
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

  // Resolve owning-server NAMES for the "Server" column / filter.
  const serverIds = [
    ...new Set(
      [
        ...rows.map((r) => r.serverId),
        ...rows.map((r) => r.buildServerId),
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

  // Which rows may be rolled back to, per app.
  const byApp = new Map<string, Deployment[]>();
  for (const row of rows) {
    const dep = assembleDeployment(row);
    const list = byApp.get(dep.appId);
    if (list) list.push(dep);
    else byApp.set(dep.appId, [dep]);
  }
  const rollbackable = new Set<string>();
  for (const p of teamApps) {
    for (const id of rollbackTargetIds(p, byApp.get(p.id) ?? [])) {
      rollbackable.add(id);
    }
  }

  // Who asked for each of these, in one query for the page - the same batch the
  // env authors and the activity trail use.
  const creators = await loadUserIdentities(rows.map((r) => r.creatorUserId));

  return rows
    .map((row) => ({ dep: assembleDeployment(row), rowServerId: row.serverId }))
    .filter(
      ({ dep }) =>
        !filter?.environment || dep.environment === filter.environment,
    )
    .filter(({ dep }) => !filter?.status || dep.status === filter.status)
    .map(({ dep, rowServerId }) => {
      const p = byId.get(dep.appId);
      const serverId = rowServerId ?? p?.serverId ?? null;
      return {
        ...dep,
        creatorUser: authorOf(dep.creatorUserId, creators),
        canRollback: rollbackable.has(dep.id),
        serviceName: p?.name ?? "",
        appSlug: p?.slug ?? "",
        appLogo: p?.logo ?? null,
        serverId,
        serverName: serverId ? (serverNameById.get(serverId) ?? null) : null,
        buildServerName:
          dep.buildServerId && dep.buildServerId !== serverId
            ? (serverNameById.get(dep.buildServerId) ?? null)
            : null,
        commitUrl: repoCommitUrl(
          { provider: p?.repoProvider, repo: p?.repoRepo, url: p?.repoUrl },
          dep.commitSha,
        ),
        pullRequestUrl: githubPullRequestUrl(
          { provider: p?.repoProvider, repo: p?.repoRepo, url: p?.repoUrl },
          dep.prNumber,
        ),
        creatorUrl: gitProfileUrl(dep.creatorProvider, dep.creator, p?.repoUrl),
      };
    });
}

export async function getDeployment(
  id: string,
): Promise<(Deployment & { canRollback: boolean }) | null> {
  const teamId = await requireActiveTeamId();
  const dep = await loadDeployment(id);
  if (!dep) return null;
  if (!(await appInTeam(dep.appId, teamId))) return null;
  // …and the app has to be one the caller can reach at all - same answer for
  // "no such deployment" and "not yours", so neither can be told apart. A
  // narrowed principal is not exempt, exactly as in `listDeployments` above.
  if ((await appCapabilities(dep.appId)).length === 0) return null;
  const creators = await loadUserIdentities([dep.creatorUserId]);
  return {
    ...dep,
    creatorUser: authorOf(dep.creatorUserId, creators),
    canRollback: await canRollbackTo(dep),
  };
}

/**
 * How far back the single-row check reads before it gives up.
 */
const ROLLBACK_SCAN_LIMIT = 200;

/**
 * Whether ONE deployment is a rollback target - the single-row read the detail
 * page needs. Shares {@link rollbackTargetIds} with the list and the gate, so all
 * three answer the same question with the same code.
 */
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

/**
 * A build's log.
 */
export async function getLogs(deploymentId: string): Promise<LogLine[]> {
  const teamId = await requireActiveTeamId();
  const dep = await loadDeployment(deploymentId);
  if (!dep) return [];
  if (!(await appInTeam(dep.appId, teamId))) return [];
  if (!(await hasAppCapability(dep.appId, "view_logs"))) return [];
  return loadDeploymentLogs(deploymentId);
}

/**
 * 1-based position of a `queued` deployment in its owning server's build queue, or
 * null when it isn't queued (already building/terminal) or isn't the active
 * team's.
 */
export async function getQueuePosition(
  deploymentId: string,
): Promise<number | null> {
  // Establish the active team (and its 2FA gate); the reach check below is
  // per-app, folder and role scope included, not the token-only clamp
  // `appInTeam` gives, so a scoped-role member can't probe a deployment id.
  await requireActiveTeamId();
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
  if (!(await hasAppCapability(target.appId, "view_logs"))) return null;
  if (target.status !== "queued" || !target.serverId) return null;

  // The queued backlog for this server, oldest-first - the SAME rows and order
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
 * Re-apply a project's routing to its already-running stack - no rebuild, no
 * redeploy.
 */
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

/* ------------------------------------------------------------------ */
/* Rollback                                                            */
/* ------------------------------------------------------------------ */

/**
 * The deployments an app can be put back on, as ids.
 *
 * Rollback runs an image a previous build LEFT ON THE HOST - Deplo pushes to no
 * registry, so what is offered has to match what retention actually kept. Five
 * conditions, and each one is a different way of being gone:
 *
 *  - it produced its own image (`image_ref`, and `rollback_of` null - a rollback
 *    row re-runs someone else's image and never adds one to the host, so it must
 *    not occupy a slot when ranking);
 *  - it SUCCEEDED, and is a production build (a preview stack is torn down with
 *    its pull request);
 *  - it ran on the server the app is on TODAY (images do not follow an app across
 *    a host move);
 *  - it is inside the app's retention window - the newest `rollback_keep` builds
 *    behind the one that is live, which is exactly what the per-slug map tells the
 *    host to keep;
 *  - it is not the image already running, which would be a deploy that changes
 *    nothing.
 *
 * ponytail: ranks SUCCESSFUL builds, while the host ranks IMAGES - a failed build
 * that got as far as tagging one occupies a slot here invisibly, so a target at
 * the very edge of the window can still be gone. The failure is safe and legible
 * (compose reports the missing image, the running container is untouched), and the
 * exact answer needs an image-listing RPC the agent does not have.
 */
function rollbackTargetIds(
  app: {
    serverId: string | null;
    rollbackKeep: number;
    source: string;
    compose: string | null;
    repoUrl: string | null;
    dockerImage: string | null;
  },
  /** The app's deployments, NEWEST FIRST - a prefix is fine (truncating can only
   *  drop candidates, never promote one into the window). */
  deps: Pick<
    Deployment,
    "id" | "status" | "environment" | "imageRef" | "rollbackOf" | "serverId"
  >[],
): Set<string> {
  // Asked of the app AS IT IS NOW.
  if (!appBuildsItsOwnImage({ ...app, repo: app.repoUrl })) return new Set();
  const production = deps.filter(
    (d) => d.environment === "production" && d.status === "ready",
  );
  // What the container is running now: the newest successful production deploy,
  // rollback rows INCLUDED (a rollback is how the live image most recently
  // changed). Anything pointing at the same image is a no-op, not a rollback.
  const liveImage = production[0]?.imageRef ?? null;
  const builds = production.filter((d) => !d.rollbackOf && d.imageRef);
  return new Set(
    builds
      // The live build plus the ones behind it that retention keeps.
      .slice(0, Math.max(0, app.rollbackKeep) + 1)
      .filter((d) => d.imageRef !== liveImage && d.serverId === app.serverId)
      .map((d) => d.id),
  );
}

/**
 * Put an app back on a previous deployment - its image, not its settings.
 */
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

  // The app AS IT IS NOW.
  if (!appBuildsItsOwnImage({ ...app, repo: app.repoUrl })) {
    throw new Error(
      "This app doesn't build an image Deplo can re-run, so it has nothing to roll back to. Only an app deployed from a repository or an uploaded archive can.",
    );
  }

  // The cheap, specific refusals first, so the common mistakes name themselves
  // instead of falling through to the generic window message.
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

  // The window is the expensive check (it needs the app's history), so it goes
  // last - and it is the same function the list uses to decide what to offer, so
  // the button and the gate can never disagree.
  const history = await loadDeploymentsForApp(dep.appId);
  const targets = rollbackTargetIds(app, history);
  if (!targets.has(dep.id)) {
    // Two ways to be outside it, and they need different sentences.
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

/** What a redeploy re-runs: only a repo has a commit to be latest. */
const REDEPLOY_MESSAGE: Record<DeploySource, string> = {
  github: "Redeploy of latest commit",
  git: "Redeploy of latest commit",
  "docker-image": "Redeploy of latest image",
  upload: "Redeploy of the uploaded archive",
  compose: "Redeploy of the compose stack",
};

/** Trigger a fresh production build + deploy of what the app deploys from. */
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

/**
 * How long the build had been running, frozen onto a row at the moment it is
 * canceled.
 */
const elapsedBuildMs = sql`case when ${deploymentsTable.startedAt} is null then null else greatest(0, (extract(epoch from (now() - ${deploymentsTable.startedAt})) * 1000)::bigint) end`;

/**
 * Stop a queued/building deployment.
 */
export async function cancelDeployment(id: string): Promise<boolean> {
  await requireMembership();
  const user = (await getCurrentUser())!;
  const dep = await loadDeployment(id);
  if (!dep) throw new Error("Deployment not found");
  await requireAppCapability(dep.appId, "deploy_apps");
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
  // change so the badge flips to "Stopped" at once - without waiting for the build
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
 * A deployment is "in progress" while it sits in the queue or is being built - its
 * row is still referenced by the deploy queue and the fire-and-forget build job,
 * so it must be CANCELED (see `cancelDeployment`), not deleted.
 */
const IN_PROGRESS: Deployment["status"][] = ["queued", "building"];

/**
 * How many deployments are in flight (queued or building) for a team, seen from
 * one member's side: a build inside a folder they can't reach - or outside a
 * narrowed token's scope - is not counted, exactly as it is not listed on the
 * Deployments page.
 */
export async function countActiveDeploymentsForTeam(
  teamId: string,
  userId: string,
): Promise<number> {
  const rows = await getDb()
    .select({ appId: deploymentsTable.appId })
    .from(deploymentsTable)
    .innerJoin(appsTable, eq(deploymentsTable.appId, appsTable.id))
    .where(
      and(
        eq(appsTable.teamId, teamId),
        appScopeWhere(),
        inArray(deploymentsTable.status, IN_PROGRESS),
      ),
    );
  // One reachability answer per DISTINCT app - the set is whatever is building
  // right now, so a handful at most, and two builds of one app ask once.
  const reachable = new Map<string, boolean>();
  let count = 0;
  for (const row of rows) {
    let ok = reachable.get(row.appId);
    if (ok === undefined) {
      ok =
        (
          await nodeCapabilitiesFor(userId, teamId, {
            kind: "app",
            id: row.appId,
          })
        ).length > 0;
      reachable.set(row.appId, ok);
    }
    if (ok) count++;
  }
  return count;
}

/**
 * Narrow a deployment sweep to one owning server.
 */
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
  // in-progress value (queued/building) yields 0 rows, which is exactly right:
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
    .where(
      inArray(
        deploymentsTable.id,
        rows.map((r) => r.id),
      ),
    )
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

/** True if the caller holds `cap` on this app, node grants included. Non-throwing
 *  companion to `requireAppCapability`, for the broad "delete/cancel all" sweep
 *  where an app the caller can't reach is skipped rather than fatal. */
async function mayManageAppFolder(
  appId: string,
  cap: "deploy_apps" | "delete_apps",
): Promise<boolean> {
  return hasAppCapability(appId, cap);
}

/**
 * Delete finished deployments by id (the multi-select "Delete selected"). Only
 * terminal rows are removed; any in-progress id in the selection is left for the
 * caller to cancel first.
 */
export async function deleteDeployments(ids: string[]): Promise<number> {
  const { membership } = await requireMembership();
  const user = (await getCurrentUser())!;
  const unique = [...new Set(ids)];
  if (unique.length === 0) return 0;
  const rows = await terminalDeploymentRows(membership.teamId, { ids: unique });
  if (rows.length === 0) return 0;
  for (const sid of new Set(rows.map((r) => r.appId)))
    await requireAppCapability(sid, "delete_apps");
  return removeDeploymentRows(rows, membership.teamId, user.name);
}

/**
 * Keep only rows whose app's folder the caller holds `cap` on - the
 * team-wide-sweep guard shared by delete-all (`delete_apps`) and cancel-all
 * (`deploy_apps`), each passing the capability its entry gate already required.
 */
async function folderPermittedRows(
  rows: { id: string; appId: string }[],
  cap: "deploy_apps" | "delete_apps",
): Promise<{ id: string; appId: string }[]> {
  const allowed = new Map<string, boolean>();
  const permitted: { id: string; appId: string }[] = [];
  for (const r of rows) {
    if (!allowed.has(r.appId))
      allowed.set(r.appId, await mayManageAppFolder(r.appId, cap));
    if (allowed.get(r.appId)) permitted.push(r);
  }
  return permitted;
}

/**
 * Delete EVERY finished deployment - for one app (`appId` given, the app page's
 * "Delete all") or across the whole active team (`appId` null/absent, the global
 * page's "Delete all").
 */
export async function deleteAllDeployments(
  appId?: string | null,
  serverId?: string | null,
  environment?: string | null,
  status?: string | null,
): Promise<number> {
  const { membership } = appId
    ? await requireAppCapability(appId, "delete_apps")
    : await requireCapability("delete_apps");
  const user = (await getCurrentUser())!;
  if (appId) {
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
  const permitted = await folderPermittedRows(rows, "delete_apps");
  return removeDeploymentRows(permitted, membership.teamId, user.name);
}

/**
 * In-progress (queued/building) deployment rows for the team, optionally narrowed
 * to one app and/or one owning server.
 */
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
  // canceled) yields 0 rows - matching the hidden "Stop all builds" button when the
  // status filter shows only finished deployments.
  if (filter.status) conds.push(eq(deploymentsTable.status, filter.status));
  return getDb()
    .select({ id: deploymentsTable.id, appId: deploymentsTable.appId })
    .from(deploymentsTable)
    .innerJoin(appsTable, eq(deploymentsTable.appId, appsTable.id))
    .where(and(...conds));
}

/**
 * Settle an app off the in-progress states the instant its build is canceled. No
 * publish here - the caller emits one snapshot after settling so subscribers paint
 * the settled status.
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

/**
 * Flip the given in-progress rows to `canceled` (same semantics as the single
 * `cancelDeployment`: the host build may finish in the background, its result just
 * isn't deployed).
 */
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
        inArray(
          deploymentsTable.id,
          rows.map((r) => r.id),
        ),
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
 * Cancel EVERY in-progress deployment - for one app (`appId` given, the app page's
 * "Stop all builds") or across the whole active team (`appId` null/absent, the
 * global page's "Stop all builds").
 */
export async function cancelAllDeployments(
  appId?: string | null,
  serverId?: string | null,
  environment?: string | null,
  status?: string | null,
): Promise<number> {
  const { membership } = appId
    ? await requireAppCapability(appId, "deploy_apps")
    : await requireCapability("deploy_apps");
  const user = (await getCurrentUser())!;
  if (appId) {
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
  const permitted = await folderPermittedRows(rows, "deploy_apps");
  return cancelDeploymentRows(permitted, membership.teamId, user.name);
}

// `listAppDeployments` lived here: an EXPORTED, ungated pass-through to
// `loadDeploymentsForApp` that took an app id from anywhere and answered with that
// app's whole history, whatever team it belonged to.

/**
 * Tear down a preview's stack. Returns `true` if it was destroyed, `false` if the
 * teardown failed (an unreachable agent, mostly) and never throws, so a dead host
 * never blocks the caller.
 */
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
