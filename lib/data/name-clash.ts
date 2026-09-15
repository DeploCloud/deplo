import "server-only";

import { and, eq, inArray, isNull, ne } from "drizzle-orm";

import { getDb } from "../db/client";
import { apps as appsTable } from "../db/schema/control-plane/apps";
import { databases as databasesTable } from "../db/schema/control-plane/databases";
import { composeNamesOnNetwork } from "../deploy/compose-stack/compose-read";
import { appNetwork } from "../deploy/network";
import { stackName } from "../deploy/deploy-key";
import { withKeyedLock } from "./keyed-mutex";

export interface Placement {
  teamId: string;
  environmentId: string | null;
  serverId: string;
}

export async function namesOnNetwork(
  to: Placement,
  exceptId: string,
): Promise<Map<string, string>> {
  const db = getDb();
  const network = appNetwork(to);
  const taken = new Map<string, string>();
  const [neighbours, dbs] = await Promise.all([
    db
      .select({
        slug: appsTable.slug,
        name: appsTable.name,
        compose: appsTable.compose,
        teamId: appsTable.teamId,
        environmentId: appsTable.environmentId,
        serverId: appsTable.serverId,
      })
      .from(appsTable)
      .where(
        and(
          eq(appsTable.teamId, to.teamId),
          ne(appsTable.id, exceptId),
          eq(appsTable.serverId, to.serverId),
          to.environmentId
            ? eq(appsTable.environmentId, to.environmentId)
            : isNull(appsTable.environmentId),
        ),
      ),
    db
      .select({
        host: databasesTable.host,
        name: databasesTable.name,
        teamId: databasesTable.teamId,
        environmentId: databasesTable.environmentId,
        serverId: databasesTable.serverId,
      })
      .from(databasesTable)
      .where(
        and(
          eq(databasesTable.teamId, to.teamId),
          ne(databasesTable.id, exceptId),
          eq(databasesTable.serverId, to.serverId),
          to.environmentId
            ? eq(databasesTable.environmentId, to.environmentId)
            : isNull(databasesTable.environmentId),
        ),
      ),
  ]);
  for (const n of neighbours) {
    if (appNetwork(n) !== network || n.serverId !== to.serverId) continue;
    const names = n.compose?.trim()
      ? composeNamesOnNetwork(n.compose)
      : [stackName(n.slug)];
    for (const name of names) taken.set(name.toLowerCase(), n.name);
  }
  for (const d of dbs) {
    if (appNetwork(d) !== network || d.serverId !== to.serverId) continue;
    taken.set(d.host.trim().toLowerCase(), d.name);
  }
  return taken;
}

export async function namesTakenOnNetwork(
  to: Placement,
  exceptId = "",
): Promise<Set<string>> {
  return new Set((await namesOnNetwork(to, exceptId)).keys());
}

export async function neighboursOnNetwork(
  to: Placement,
  exceptId: string,
): Promise<string[]> {
  return [...new Set((await namesOnNetwork(to, exceptId)).values())].sort();
}

export async function assertNoNameClash(opts: {
  to: Placement;
  claims: string[];
  exceptId: string;
  subject: string;
}): Promise<void> {
  const claims = opts.claims.map((c) => c.trim().toLowerCase()).filter(Boolean);
  if (claims.length === 0) return;
  const taken = await namesOnNetwork(opts.to, opts.exceptId);
  for (const claim of claims) {
    const owner = taken.get(claim);
    if (!owner) continue;
    let free = `${claim}-2`;
    for (let n = 2; taken.has(free); n++) free = `${claim}-${n}`;
    throw new Error(
      `\`${claim}\` is already answered by ${owner} on that network, and Docker ` +
        `would split the connections between the two. Rename it on ${opts.subject} ` +
        `(the service, or its \`hostname:\`) - \`${free}\` is free - or pick ` +
        `another environment.`,
    );
  }
}

export async function nameClashesOnMove(
  appIds: string[],
  to: Omit<Placement, "serverId">,
): Promise<string[]> {
  if (appIds.length === 0) return [];
  const rows = await getDb()
    .select({
      id: appsTable.id,
      slug: appsTable.slug,
      name: appsTable.name,
      compose: appsTable.compose,
      serverId: appsTable.serverId,
    })
    .from(appsTable)
    .where(inArray(appsTable.id, appIds));
  const out: string[] = [];
  for (const row of rows) {
    const claims = row.compose?.trim()
      ? composeNamesOnNetwork(row.compose)
      : [stackName(row.slug)];
    try {
      await assertNoNameClash({
        to: { ...to, serverId: row.serverId },
        claims,
        exceptId: row.id,
        subject: row.name,
      });
    } catch (e) {
      out.push(e instanceof Error ? e.message : String(e));
    }
  }
  return out;
}

/**
 * withNetworkLock serialises the check of a name against a network and the write to it.
 *
 * ponytail: per-process lock, so it serialises one control plane, not two against
 * one database. A Postgres advisory lock keyed the same way is the real fix.
 */
export function withNetworkLock<T>(
  to: Omit<Placement, "serverId">,
  fn: () => Promise<T>,
): Promise<T> {
  return withKeyedLock(
    `network-names:${to.teamId}:${to.environmentId ?? ""}`,
    fn,
  );
}
