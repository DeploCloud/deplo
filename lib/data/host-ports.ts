import "server-only";

import { and, eq, ne } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  appPorts as appPortsTable,
  apps as appsTable,
  databases as databasesTable,
} from "../db/schema/control-plane";

/**
 * Whether anything on this server ALREADY holds this host port - another team's
 * app or database included. Servers are shared and a host port is a singleton on
 * the machine, so the answer cannot depend on who is asking.
 */
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
        // A stack that became compose publishes what its own YAML says and
        // nothing else - its rows are kept for a flip back, not as a claim.
        ne(appsTable.source, "compose"),
      ),
    );
  return claimed.some((r) => r.id !== except?.appId);
}
