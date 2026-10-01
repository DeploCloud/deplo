import "server-only";

import { and, eq, inArray } from "drizzle-orm";

import { getDb } from "../db/client";
import { tryDecryptSecret } from "../crypto";
import { apps as appsTable } from "../db/schema/control-plane/apps";
import { databases as databasesTable } from "../db/schema/control-plane/databases";
import {
  envVars as envVarsTable,
  sharedEnvVarApps as sharedEnvVarAppsTable,
  sharedEnvVars as sharedEnvVarsTable,
} from "../db/schema/control-plane/env-vars";

export interface DatabaseUse {
  appId: string;
  appName: string;
  databaseId: string;
  databaseName: string;
}

const HOST_CHAR = "A-Za-z0-9._-";

// A host is a whole token: `db-shop` must not match inside `db-shop-2` or `x.db-shop`.
export function mentionsHost(text: string, host: string): boolean {
  const escaped = host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(?<![${HOST_CHAR}])${escaped}(?![${HOST_CHAR}])`,
    "i",
  ).test(text);
}

// Which of a team's apps reach which of its databases by the in-network host,
// read from the app's own variables, its linked shared variables and its compose.
export async function databaseUsesInTeam(
  teamId: string,
  filter: { databaseIds?: string[]; appIds?: string[] },
): Promise<DatabaseUse[]> {
  const db = getDb();
  const dbs = await db
    .select({
      id: databasesTable.id,
      name: databasesTable.name,
      host: databasesTable.host,
    })
    .from(databasesTable)
    .where(
      and(
        eq(databasesTable.teamId, teamId),
        filter.databaseIds
          ? inArray(databasesTable.id, filter.databaseIds)
          : undefined,
      ),
    );
  if (dbs.length === 0) return [];
  const apps = await db
    .select({
      id: appsTable.id,
      name: appsTable.name,
      compose: appsTable.compose,
    })
    .from(appsTable)
    .where(
      and(
        eq(appsTable.teamId, teamId),
        filter.appIds ? inArray(appsTable.id, filter.appIds) : undefined,
      ),
    );
  if (apps.length === 0) return [];
  const appIds = apps.map((a) => a.id);

  const [own, shared] = await Promise.all([
    db
      .select({ appId: envVarsTable.appId, valueEnc: envVarsTable.valueEnc })
      .from(envVarsTable)
      .where(inArray(envVarsTable.appId, appIds)),
    db
      .select({
        appId: sharedEnvVarAppsTable.appId,
        valueEnc: sharedEnvVarsTable.valueEnc,
      })
      .from(sharedEnvVarAppsTable)
      .innerJoin(
        sharedEnvVarsTable,
        eq(sharedEnvVarsTable.id, sharedEnvVarAppsTable.varId),
      )
      .where(inArray(sharedEnvVarAppsTable.appId, appIds)),
  ]);
  const text = new Map(apps.map((a) => [a.id, [a.compose ?? ""]]));
  for (const row of [...own, ...shared]) {
    const v = tryDecryptSecret(row.valueEnc);
    if (v.ok) text.get(row.appId)?.push(v.value);
  }

  const uses: DatabaseUse[] = [];
  for (const app of apps) {
    const haystack = text.get(app.id)!.join("\n");
    for (const d of dbs)
      if (mentionsHost(haystack, d.host))
        uses.push({
          appId: app.id,
          appName: app.name,
          databaseId: d.id,
          databaseName: d.name,
        });
  }
  return uses.sort((a, b) => a.appName.localeCompare(b.appName));
}
