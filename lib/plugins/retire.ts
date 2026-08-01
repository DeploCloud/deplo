import "server-only";

/**
 * Retirement sweep for the withdrawn Plugins feature (ADR-0013).
 *
 * The Plugins UI, GraphQL surface and catalog client are gone, but an instance
 * that ran an earlier version may still have an installed plugin: a container
 * (`deplo-app-<slug>`), its rendered stack file, and a Traefik path router on
 * `/plugins/<slug>`. With no UI left, the only way for the owner to remove that
 * would be a shell on the host — which the core mission forbids. So the control
 * plane removes it ITSELF, once, at boot.
 *
 * Runs on every boot and is a no-op on the overwhelmingly common empty table
 * (one indexed SELECT). Best-effort by construction: `destroyPluginContainer`
 * never throws, and a row is dropped only after its teardown has been attempted,
 * so a boot that can't reach the Docker daemon leaves the row for the next one
 * instead of losing track of a live container.
 *
 * DELETE THIS MODULE when the feature returns — at that point an
 * `installed_plugins` row means "installed", not "left behind".
 */

import { eq } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  installedPlugins as installedPluginsTable,
  teams as teamsTable,
} from "../db/schema/control-plane";
import { pluginSlug, destroyPluginContainer } from "./runtime";

/**
 * Tear down every installed plugin and empty the table. `destroy` is injectable
 * for tests only — production always sweeps through the real runtime.
 *
 * Legacy rows written before `slug` was persisted carry an empty string; those
 * derive the slug the same way the installer did (`catalogId` + the owning
 * team's slug), which is what the live container is actually named.
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
    console.log(`[deplo] retired installed plugin ${slug} (the feature is deferred — ADR-0013)`);
  }
  return retired;
}
