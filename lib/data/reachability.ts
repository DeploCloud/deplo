import "server-only";

// https://deplo.build/docs/advanced/network-isolation

import { and, eq, ne } from "drizzle-orm";

import { getDb } from "../db/client";
import { apps as appsTable } from "../db/schema/control-plane/apps";
import { databases as databasesTable } from "../db/schema/control-plane/databases";
import { appNetwork } from "../deploy/network";
import { usesAsHost } from "../deploy/cross-network";
import { appEnv } from "../deploy/build/deploy-env";
import type { Placement } from "./name-clash";

// LostNeighbour is a name this app reaches today and would lose after the move.
export interface LostNeighbour {
  name: string;
  kind: "database" | "app";
}

async function safeEnv(appId: string): Promise<Record<string, string>> {
  try {
    return await appEnv(appId);
  } catch {
    return {};
  }
}

// neighboursLostByMove lists what this app reaches today and would lose by moving to `to`.
export async function neighboursLostByMove(
  appId: string,
  to: Omit<Placement, "serverId">,
): Promise<LostNeighbour[]> {
  const db = getDb();
  const [app] = await db
    .select({
      teamId: appsTable.teamId,
      serverId: appsTable.serverId,
      environmentId: appsTable.environmentId,
      compose: appsTable.compose,
    })
    .from(appsTable)
    .where(eq(appsTable.id, appId))
    .limit(1);
  if (!app) return [];
  const from = appNetwork(app);
  const after = appNetwork({
    teamId: app.teamId,
    environmentId: to.environmentId,
  });
  if (from === after) return [];

  const env = await safeEnv(appId);
  const compose = (app.compose ?? "").toLowerCase();
  const names = (name: string): boolean =>
    compose.includes(name.toLowerCase()) ||
    Object.entries(env).some(([k, v]) => usesAsHost(k, v, name));

  const [dbs, apps] = await Promise.all([
    db
      .select({
        host: databasesTable.host,
        teamId: databasesTable.teamId,
        environmentId: databasesTable.environmentId,
        serverId: databasesTable.serverId,
      })
      .from(databasesTable)
      .where(eq(databasesTable.teamId, app.teamId)),
    db
      .select({
        slug: appsTable.slug,
        compose: appsTable.compose,
        teamId: appsTable.teamId,
        environmentId: appsTable.environmentId,
        serverId: appsTable.serverId,
      })
      .from(appsTable)
      .where(and(eq(appsTable.teamId, app.teamId), ne(appsTable.id, appId))),
  ]);

  const out: LostNeighbour[] = [];
  for (const d of dbs) {
    if (d.serverId !== app.serverId) continue;
    if (appNetwork(d) !== from || appNetwork(d) === after) continue;
    if (names(d.host)) out.push({ name: d.host, kind: "database" });
  }
  for (const n of apps) {
    if (n.serverId !== app.serverId) continue;
    if (appNetwork(n) !== from || appNetwork(n) === after) continue;
    const { composeNamesOnNetwork } =
      await import("../deploy/compose-stack/compose-read");
    const claimed = n.compose?.trim() ? composeNamesOnNetwork(n.compose) : [];
    for (const name of claimed)
      if (names(name)) out.push({ name, kind: "app" });
  }
  return out;
}

// lostNeighbourMessage is the line a move records when it takes something out of reach.
export function lostNeighbourMessage(
  appName: string,
  lost: LostNeighbour[],
): string {
  const names = lost.map((l) => `\`${l.name}\``).join(", ");
  return (
    `${appName} was moved and can no longer reach ${names}, which it points at. ` +
    `Move ${lost.length === 1 ? "it" : "them"} to the same place, or the app will ` +
    `fail with "cannot resolve host" on its next deploy.`
  );
}
