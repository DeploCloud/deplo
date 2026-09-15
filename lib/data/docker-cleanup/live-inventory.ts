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
    out[r.slug] = Math.min(
      MAX_ROLLBACK_KEEP + 1,
      Math.max(1, Math.trunc(r.keep) + 1),
    );
  }
  return out;
}

export async function liveStackSlugs(): Promise<string[]> {
  const db = getDb();
  const [apps, previews, databases] = await Promise.all([
    db.select({ slug: appsTable.slug }).from(appsTable),
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

export async function liveNetworkNames(): Promise<string[]> {
  const db = getDb();
  const [apps, previews] = await Promise.all([
    db
      .select({
        teamId: appsTable.teamId,
        environmentId: appsTable.environmentId,
      })
      .from(appsTable),
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
