import "server-only";

import { inArray, type SQL } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  apps as appsTable,
  appBuild as appBuildTable,
} from "../db/schema/control-plane";
import { parseWatchPaths } from "../data/app-graph-rows";
import { startDeployment } from "./build";
import { shouldAutoDeploy, type GitPushEvent } from "./git-webhook";

/**
 * Turning ONE verified push into deployments - shared by every git provider's
 * webhook route. Runs with no session: a delivery is authenticated by its
 * signature, not by a user, so nothing here may call a capability gate.
 */
export async function dispatchPushEvent(opts: {
  /** Which apps this delivery could possibly target (a SQL fragment). */
  match: SQL;
  /** owner/name as the provider spells it. */
  repoFullName: string;
  event: GitPushEvent;
  /** Who to credit in the deployment - a login on `provider`, not a deplo user. */
  creator: string;
  /** The git host that login belongs to, so the build says whose account it was. */
  provider: string;
  commitMessage: string;
  /** Log prefix, so a dropped delivery is traceable to its route. */
  logTag: string;
}): Promise<number> {
  const { match, repoFullName, event, logTag } = opts;
  if (!event.refName) return 0;

  const db = getDb();
  const wired = await db.select().from(appsTable).where(match);
  // First cut on the row-local facts (auto-deploy + repo match).
  const candidates = wired.filter(
    (p) => p.autoDeploy && p.repoRepo === repoFullName,
  );
  const buildRows = candidates.length
    ? await db
        .select()
        .from(appBuildTable)
        .where(
          inArray(
            appBuildTable.appId,
            candidates.map((p) => p.id),
          ),
        )
    : [];
  const buildById = new Map(buildRows.map((b) => [b.appId, b]));
  const targets = candidates.filter((p) =>
    shouldAutoDeploy(
      {
        branch: p.repoBranch || "main",
        triggerType: p.repoTriggerType === "tag" ? "tag" : "push",
        watchPaths: parseWatchPaths(p.repoWatchPaths),
        rootDirectory: buildById.get(p.id)?.rootDirectory ?? null,
        skipUnchanged: buildById.get(p.id)?.skipUnchangedDeployments ?? false,
      },
      event,
    ),
  );

  if (targets.length === 0) {
    // The silent-failure heart of these endpoints: a delivered, verified push that
    // matches no app returns 200 with no deploy.
    console.warn(
      `[${logTag}] no auto-deploy target: repo=${repoFullName} ref=${event.refName} ` +
        `isTag=${event.isTag} deleted=${event.deleted}; candidates=` +
        JSON.stringify(
          wired.map((p) => ({
            id: p.id,
            autoDeploy: p.autoDeploy,
            repo: p.repoRepo,
            branch: p.repoBranch,
            triggerType: p.repoTriggerType,
            watchPaths: p.repoWatchPaths,
          })),
        ),
    );
    return 0;
  }

  let started = 0;
  for (const p of targets) {
    try {
      await startDeployment(p.id, {
        environment: "production",
        creator: opts.creator,
        creatorProvider: opts.provider,
        commitMessage: opts.commitMessage,
        // For a tag trigger the deploy checks out the tag itself; for a push it
        // is the tracked branch (event.refName === repoBranch here).
        branch: event.refName,
      });
      started++;
    } catch (e) {
      // One app must not stop the delivery, but a push that silently deploys nothing is
      // the worst version of that: the refusals reachable here are real states someone
      // has to fix (data a migration could not copy, an app on its way out), and they
      console.warn(
        `[${opts.logTag}] ${p.slug}: not deployed - ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return started;
}
