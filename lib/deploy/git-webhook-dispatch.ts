import "server-only";

import { inArray, type SQL } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  apps as appsTable,
  appBuild as appBuildTable,
} from "../db/schema/control-plane/apps";
import { parseWatchPaths } from "../data/app-graph-rows/app";
import { startDeployment } from "./build/deploy-start";
import { shouldAutoDeploy, type GitPushEvent } from "./git-webhook";

export async function dispatchPushEvent(opts: {
  match: SQL;
  repoFullName: string;
  event: GitPushEvent;
  creator: string;
  provider: string;
  commitMessage: string;
  logTag: string;
}): Promise<number> {
  const { match, repoFullName, event, logTag } = opts;
  if (!event.refName) return 0;

  const db = getDb();
  const wired = await db.select().from(appsTable).where(match);
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
        branch: event.refName,
      });
      started++;
    } catch (e) {
      console.warn(
        `[${opts.logTag}] ${p.slug}: not deployed - ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return started;
}
