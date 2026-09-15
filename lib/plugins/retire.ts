import "server-only";

import { eq } from "drizzle-orm";

import { getDb } from "../db/client";
import { teams as teamsTable } from "../db/schema/control-plane/identity";
import { installedPlugins as installedPluginsTable } from "../db/schema/control-plane/integrations";
import { pluginSlug, destroyPluginContainer } from "./runtime";

export async function retireInstalledPlugins(
  destroy: (slug: string) => Promise<void> = destroyPluginContainer,
): Promise<number> {
  const rows = await getDb()
    .select({
      id: installedPluginsTable.id,
      catalogId: installedPluginsTable.catalogId,
      slug: installedPluginsTable.slug,
      teamSlug: teamsTable.slug,
    })
    .from(installedPluginsTable)
    .leftJoin(teamsTable, eq(teamsTable.id, installedPluginsTable.teamId));
  if (rows.length === 0) return 0;

  let retired = 0;
  for (const row of rows) {
    const slug = row.slug || pluginSlug(row.catalogId, row.teamSlug ?? "");
    try {
      await destroy(slug);
    } catch (e) {
      console.error(`[deplo] could not retire plugin ${slug}:`, e);
      continue;
    }
    await getDb()
      .delete(installedPluginsTable)
      .where(eq(installedPluginsTable.id, row.id));
    retired++;
    console.log(
      `[deplo] retired installed plugin ${slug} (the feature is deferred - ADR-0013)`,
    );
  }
  return retired;
}
