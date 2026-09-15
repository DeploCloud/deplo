import "server-only";

import { eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { composeServiceNames } from "../../deploy/compose-stack/compose-read";
import { routedServiceSql } from "../../crons/runner/targets";

export function appServices(compose: string | null, slug: string): string[] {
  if (!compose) return [slug];
  const names = composeServiceNames(compose);
  return names.length > 0 ? names : [slug];
}

export async function routedServiceOf(appId: string): Promise<string | null> {
  const rows = await getDb()
    .select({ service: routedServiceSql(appsTable.id) })
    .from(appsTable)
    .where(eq(appsTable.id, appId))
    .limit(1);
  return rows[0]?.service ?? null;
}

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
