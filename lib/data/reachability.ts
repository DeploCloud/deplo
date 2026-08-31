import "server-only";

// https://deplo.build/docs/advanced/network-isolation

import { and, eq, ne } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  apps as appsTable,
  databases as databasesTable,
} from "../db/schema/control-plane";
import { appNetwork } from "../deploy/network";
import { usesAsHost } from "../deploy/cross-network";
import { appEnv } from "../deploy/build";
import type { Placement } from "./name-clash";

/** A neighbour this app names today and would stop resolving after the move. */
export interface LostNeighbour {
  /** The DNS name the app points at. */
  name: string;
  /** What it is, for the sentence: `database` or `app`. */
  kind: "database" | "app";
}

/** The env of an app, or nothing when it cannot be read. Never throws. */
async function safeEnv(appId: string): Promise<Record<string, string>> {
  try {
    return await appEnv(appId);
  } catch {
    return {};
  }
}

/**
 * What this app names TODAY, can reach today, and would stop reaching if it moved
 * to `to`.
 *
 * This is the question a placement change actually raises, and no check asked it:
 * "I have my apps and my Postgres at the top level, now I organise them into a
 * Project" moves the apps and leaves the database behind, and the app falls over
 * with `cannot resolve host` on a click whose tooltip promised nothing of the sort.
 *
 * Heuristic in the same way the deploy-time warning is (`usesAsHost`), so it
 * informs rather than refuses.
 */
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
    // Reachable now, not after: that is what the mover has to be told.
    if (d.serverId !== app.serverId) continue;
    if (appNetwork(d) !== from || appNetwork(d) === after) continue;
    if (names(d.host)) out.push({ name: d.host, kind: "database" });
  }
  for (const n of apps) {
    if (n.serverId !== app.serverId) continue;
    if (appNetwork(n) !== from || appNetwork(n) === after) continue;
    const { composeNamesOnNetwork } = await import("../deploy/compose-stack");
    const claimed = n.compose?.trim() ? composeNamesOnNetwork(n.compose) : [];
    for (const name of claimed)
      if (names(name)) out.push({ name, kind: "app" });
  }
  return out;
}

/** The one line a move records when it takes something out of reach. */
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
