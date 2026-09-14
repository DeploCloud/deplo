import "server-only";

import { eq, isNull } from "drizzle-orm";

import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { databases as databasesTable } from "../../db/schema/control-plane/databases";
import { appPreviews as appPreviewsTable } from "../../db/schema/control-plane/deployments";
import { appBuildsItsOwnImage } from "../../utils";
import { previewDeployKey } from "../../deploy/deploy-key";
import { appNetwork, previewNetwork } from "../../deploy/network";
import { MAX_ROLLBACK_KEEP } from "../../types/app";

/**
 * How many app images each app on `serverId` must keep - its rollback depth plus
 * the one that is live. An app at 0 lands on 1, which is also the floor the agent
 * enforces anyway (a stopped app must stay startable without a rebuild).
 */
export async function rollbackKeepBySlug(
  serverId: string,
): Promise<Record<string, number>> {
  const rows = await getDb()
    .select({
      slug: appsTable.slug,
      keep: appsTable.rollbackKeep,
      source: appsTable.source,
      compose: appsTable.compose,
      repoUrl: appsTable.repoUrl,
      dockerImage: appsTable.dockerImage,
    })
    .from(appsTable)
    .where(eq(appsTable.serverId, serverId));
  const out: Record<string, number> = {};
  for (const r of rows) {
    if (!appBuildsItsOwnImage({ ...r, repo: r.repoUrl })) continue;
    // Clamped at BOTH ends, not just the floor.
    out[r.slug] = Math.min(
      MAX_ROLLBACK_KEEP + 1,
      Math.max(1, Math.trunc(r.keep) + 1),
    );
  }
  return out;
}

/**
 * Every stack slug this Deplo still knows about - the proof `leftover_app_files`
 * rests on, and the one list that decides whether a directory on a host is
 * somebody's configuration or litter.
 */
export async function liveStackSlugs(): Promise<string[]> {
  const db = getDb();
  const [apps, previews, databases] = await Promise.all([
    db.select({ slug: appsTable.slug }).from(appsTable),
    // A preview's row outlives its stack, so only one whose stack is NOT confirmed
    // gone still vouches for anything on a host.
    db
      .select({ slug: appsTable.slug, prNumber: appPreviewsTable.prNumber })
      .from(appPreviewsTable)
      .innerJoin(appsTable, eq(appsTable.id, appPreviewsTable.appId))
      .where(isNull(appPreviewsTable.tornDownAt)),
    db.select({ host: databasesTable.host }).from(databasesTable),
  ]);
  const slugs = new Set<string>();
  for (const a of apps) slugs.add(a.slug);
  for (const p of previews) slugs.add(previewDeployKey(p.slug, p.prNumber));
  for (const d of databases) slugs.add(d.host);
  return [...slugs];
}

/**
 * Every tenant network this Deplo still knows about - the proof `leftover_networks`
 * rests on. Instance-wide, like {@link liveStackSlugs}: which ones are LIVE is a
 * control-plane fact, and scoping per server would call one litter everywhere else.
 */
export async function liveNetworkNames(): Promise<string[]> {
  const db = getDb();
  const [apps, previews] = await Promise.all([
    db
      .select({
        teamId: appsTable.teamId,
        environmentId: appsTable.environmentId,
      })
      .from(appsTable),
    // Same cut as `liveStackSlugs`: a torn-down preview's network is litter, and
    // counting it live is what kept one Docker network per closed pull request.
    db
      .select({ slug: appsTable.slug, prNumber: appPreviewsTable.prNumber })
      .from(appPreviewsTable)
      .innerJoin(appsTable, eq(appsTable.id, appPreviewsTable.appId))
      .where(isNull(appPreviewsTable.tornDownAt)),
  ]);
  const dbs = await db
    .select({
      teamId: databasesTable.teamId,
      environmentId: databasesTable.environmentId,
    })
    .from(databasesTable);
  const names = new Set<string>();
  for (const a of [...apps, ...dbs]) names.add(appNetwork(a));
  for (const p of previews)
    names.add(previewNetwork(previewDeployKey(p.slug, p.prNumber)));
  return [...names];
}
