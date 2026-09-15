import "server-only";

import { and, eq, ne } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  appPorts as appPortsTable,
  apps as appsTable,
} from "../db/schema/control-plane/apps";
import { databases as databasesTable } from "../db/schema/control-plane/databases";

export async function hostPortClaimed(
  serverId: string,
  port: number,
  except?: { appId?: string; databaseId?: string },
): Promise<boolean> {
  const db = getDb();
  const dbs = await db
    .select({ id: databasesTable.id })
    .from(databasesTable)
    .where(
      and(
        eq(databasesTable.serverId, serverId),
        eq(databasesTable.exposedPublicly, true),
        eq(databasesTable.exposedPort, port),
      ),
    );
  if (dbs.some((r) => r.id !== except?.databaseId)) return true;
  const claimed = await db
    .select({ id: appsTable.id })
    .from(appPortsTable)
    .innerJoin(appsTable, eq(appsTable.id, appPortsTable.appId))
    .where(
      and(
        eq(appsTable.serverId, serverId),
        eq(appPortsTable.published, port),
        ne(appsTable.source, "compose"),
      ),
    );
  return claimed.some((r) => r.id !== except?.appId);
}
