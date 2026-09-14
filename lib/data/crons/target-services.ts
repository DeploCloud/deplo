import "server-only";

import { eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { composeServiceNames } from "../../deploy/compose-stack/compose-read";
import { routedServiceSql } from "../../crons/runner/targets";

/**
 * The compose services a job may pick, read from the app's own stack DOCUMENT
 * rather than from the live host. A stopped app must still be configurable, and
 * asking the agent here would make the page fail whenever the server is down.
 */
export function appServices(compose: string | null, slug: string): string[] {
  if (!compose) return [slug];
  const names = composeServiceNames(compose);
  return names.length > 0 ? names : [slug];
}

/** The service the app's domain routes to, by the scheduler's own rule. */
export async function routedServiceOf(appId: string): Promise<string | null> {
  const rows = await getDb()
    .select({ service: routedServiceSql(appsTable.id) })
    .from(appsTable)
    .where(eq(appsTable.id, appId))
    .limit(1);
  return rows[0]?.service ?? null;
}

/**
 * A named container must be one the target has. Refused HERE: unchecked, the
 * job is stored and only says so at 3am, as "not running".
 */
export function assertServiceInTarget(
  service: string | null | undefined,
  app: { compose: string | null; slug: string } | null,
): void {
  if (!service) return;
  if (!app) {
    throw new Error("A database has one container - leave the container empty");
  }
  if (!appServices(app.compose, app.slug).includes(service)) {
    throw new Error(`No container named "${service}" in this app`);
  }
}
