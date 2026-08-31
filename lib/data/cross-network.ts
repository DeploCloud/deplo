import "server-only";

import { and, asc, eq, isNull, ne, or } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  apps as appsTable,
  databases as databasesTable,
  environments as environmentsTable,
  projects as projectsTable,
} from "../db/schema/control-plane";
import { composeClaimedNames } from "../deploy/compose-lint";
import { appNetwork } from "../deploy/network";
import { stackName } from "../deploy/deploy-key";
import type { Neighbour } from "../deploy/cross-network";

/** How many neighbours to read. A host with more than this has bigger problems. */
const MAX_NEIGHBOURS = 200;

/**
 * Every DNS name a stack of this team answers to that could matter to this app:
 * the ones it cannot reach, and the ones it CAN, which is what a name collision
 * is made of. Another TEAM is never named: it is unreachable by construction, so
 * saying so would only leak their project.
 */
export async function neighboursForApp(a: {
  id: string;
  serverId: string;
  teamId: string;
  environmentId?: string | null;
}): Promise<Neighbour[]> {
  const mine = appNetwork(a);
  const db = getDb();
  // The same placement, NULL (the team's top level) included - the other half of
  // "could matter", since a neighbour there shares this app's network by name.
  const envId = a.environmentId ?? null;
  const appPlaced = envId
    ? eq(appsTable.environmentId, envId)
    : isNull(appsTable.environmentId);
  const dbPlaced = envId
    ? eq(databasesTable.environmentId, envId)
    : isNull(databasesTable.environmentId);
  const [neighbours, dbs] = await Promise.all([
    db
      .select({
        slug: appsTable.slug,
        compose: appsTable.compose,
        teamId: appsTable.teamId,
        serverId: appsTable.serverId,
        environmentId: appsTable.environmentId,
        envName: environmentsTable.name,
        projectName: projectsTable.name,
      })
      .from(appsTable)
      .leftJoin(
        environmentsTable,
        eq(appsTable.environmentId, environmentsTable.id),
      )
      .leftJoin(
        projectsTable,
        eq(environmentsTable.projectId, projectsTable.id),
      )
      // Same TEAM as well as same host: another team's network is unreachable by
      // construction, so naming one would only leak their project name. Narrowed to
      // the neighbours that can matter - this host, or this placement on another one -
      // so the cap cannot silently drop the one the app actually names.
      .where(
        and(
          eq(appsTable.teamId, a.teamId),
          ne(appsTable.id, a.id),
          or(eq(appsTable.serverId, a.serverId), appPlaced),
        ),
      )
      .orderBy(asc(appsTable.slug))
      .limit(MAX_NEIGHBOURS),
    db
      .select({
        host: databasesTable.host,
        teamId: databasesTable.teamId,
        serverId: databasesTable.serverId,
        environmentId: databasesTable.environmentId,
        envName: environmentsTable.name,
        projectName: projectsTable.name,
      })
      .from(databasesTable)
      .leftJoin(
        environmentsTable,
        eq(databasesTable.environmentId, environmentsTable.id),
      )
      .leftJoin(
        projectsTable,
        eq(environmentsTable.projectId, projectsTable.id),
      )
      .where(
        and(
          eq(databasesTable.teamId, a.teamId),
          or(eq(databasesTable.serverId, a.serverId), dbPlaced),
        ),
      )
      .orderBy(asc(databasesTable.host))
      .limit(MAX_NEIGHBOURS),
  ]);

  const out: Neighbour[] = [];
  const add = (
    name: string,
    network: string,
    serverId: string,
    where: string,
  ) => {
    if (!name) return;
    const sameNetwork = network === mine;
    const sameHost = serverId === a.serverId;
    // Reachable is same network name AND same machine. Anything else is a name this
    // app will not resolve, and the two reasons take different advice.
    out.push({
      name: name.toLowerCase(),
      network,
      where,
      why:
        sameNetwork && sameHost
          ? "reachable"
          : sameNetwork
            ? "other-host"
            : "elsewhere",
    });
  };
  for (const n of neighbours) {
    const net = appNetwork(n);
    const where = placeLabel(n.projectName, n.envName);
    // A compose stack answers to every service name it declares; a single-image
    // one answers to its container, which is the stack name.
    const names = n.compose?.trim()
      ? composeClaimedNames(n.compose)
      : [stackName(n.slug)];
    for (const name of names) add(name, net, n.serverId, where);
  }
  for (const d of dbs)
    add(
      d.host,
      appNetwork(d),
      d.serverId,
      placeLabel(d.projectName, d.envName),
    );
  return out;
}

/**
 * Where a neighbour lives, said the way the user could act on it. An app with no
 * Environment is at the team's top level, and telling someone to "move into that
 * environment" when there is none is advice they cannot follow.
 */
function placeLabel(project: string | null, env: string | null): string {
  return project && env ? `${project} / ${env}` : "the team's top level";
}

/**
 * Strip a neighbour down to what a caller may be told. A deploy log is readable by
 * whoever can deploy the app, and a member scoped to one folder should not learn
 * the service names and project layout of the parts of the team they cannot reach.
 * The NAME still has to appear - it is the one the app itself wrote - but where it
 * lives does not.
 */
export function redactNeighbours(
  list: Neighbour[],
  maySeeWhere: boolean,
): Neighbour[] {
  if (maySeeWhere) return list;
  return list.map((n) => ({ ...n, where: "another part of this team" }));
}
