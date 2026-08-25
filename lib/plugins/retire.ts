import "server-only";

/**
 * Retirement sweep for the withdrawn Plugins feature (ADR-0013). With no UI left,
 * the only way for the owner to remove that would be a shell on the host — which
 * the core mission forbids.
 */

import { eq } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  installedPlugins as installedPluginsTable,
  teams as teamsTable,
} from "../db/schema/control-plane";
import { pluginSlug, destroyPluginContainer } from "./runtime";

/**
 * Tear down every installed plugin and empty the table.
 */
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
      // Keep the row: it is the only record that this container exists, and a
      // later boot (or a reachable daemon) must still get the chance to remove it.
      console.error(`[deplo] could not retire plugin ${slug}:`, e);
      continue;
    }
    await getDb()
      .delete(installedPluginsTable)
      .where(eq(installedPluginsTable.id, row.id));
    retired++;
    console.log(
      `[deplo] retired installed plugin ${slug} (the feature is deferred — ADR-0013)`,
    );
  }
  return retired;
}
