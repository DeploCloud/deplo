import "server-only";

// https://deplo.build/docs/advanced/network-isolation

import { and, eq, ne } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  apps as appsTable,
  databases as databasesTable,
} from "../db/schema/control-plane";
import { composeClaimedNames } from "../deploy/compose-lint";
import { appNetwork } from "../deploy/network";
import { stackName } from "../deploy/deploy-key";

/** Where a workload would sit: the two fields that decide its network. */
export interface Placement {
  teamId: string;
  environmentId: string | null;
  serverId: string;
}

/**
 * The DNS names already answered on `to`'s network, by everything but `exceptId`.
 *
 * A name is only contested by a neighbour on the SAME network AND the same host -
 * a Docker network lives on one machine, so a database in another Environment is
 * not a clash and refusing it would only take an ordinary name away.
 */
async function namesOnNetwork(
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
      .where(and(eq(appsTable.teamId, to.teamId), ne(appsTable.id, exceptId))),
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
        ),
      ),
  ]);
  for (const n of neighbours) {
    if (appNetwork(n) !== network || n.serverId !== to.serverId) continue;
    const names = n.compose?.trim()
      ? composeClaimedNames(n.compose)
      : [stackName(n.slug)];
    for (const name of names) taken.set(name.toLowerCase(), n.name);
  }
  for (const d of dbs) {
    if (appNetwork(d) !== network || d.serverId !== to.serverId) continue;
    taken.set(d.host.trim().toLowerCase(), d.name);
  }
  return taken;
}

/**
 * Refuse a workload whose DNS names a neighbour on the destination network already
 * answers to. Docker round-robins a name two containers both claim, so half the
 * lookups reach the wrong one - which reads as an intermittent network fault, not
 * as a name collision.
 *
 * Every writer that can create the overlap has to ask: creating either side, and
 * MOVING either side onto the other's network.
 */
export async function assertNoNameClash(opts: {
  to: Placement;
  /** The names the thing being placed would answer to. */
  claims: string[];
  /** The row being created or moved, excluded from its own check. */
  exceptId: string;
  /** How to name the thing in the refusal. */
  subject: string;
}): Promise<void> {
  const claims = opts.claims.map((c) => c.trim().toLowerCase()).filter(Boolean);
  if (claims.length === 0) return;
  const taken = await namesOnNetwork(opts.to, opts.exceptId);
  for (const claim of claims) {
    const owner = taken.get(claim);
    if (!owner) continue;
    throw new Error(
      `\`${claim}\` is already answered by ${owner} on that network, and Docker ` +
        `would split the connections between the two. Rename it on ${opts.subject} ` +
        `(the service, or its \`hostname:\`), or pick another environment.`,
    );
  }
}
