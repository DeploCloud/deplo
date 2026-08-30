import "server-only";

import { and, eq, ne } from "drizzle-orm";

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
import type { ForeignName } from "../deploy/cross-network";

/** How many neighbours to read. A host with more than this has bigger problems. */
const MAX_NEIGHBOURS = 200;

/**
 * Every DNS name a stack of this TEAM answers to that this app cannot resolve -
 * what turns into "cannot resolve host" the moment it deploys. Two ways to be out
 * of reach, and they need different advice:
 *
 *  - another network (another Environment, or the team's top level): a placement
 *    to change;
 *  - the SAME placement on ANOTHER SERVER: a Docker network is local to its host,
 *    so sharing an Environment is not enough and no placement fixes it. This one
 *    used to be skipped as "not news", which left the commonest cross-host mistake
 *    silent while the docs promised it would work.
 *
 * Another TEAM is never named: it is unreachable by construction, so saying so
 * would only leak their project.
 */
export async function foreignNamesForApp(a: {
  id: string;
  serverId: string;
  teamId: string;
  environmentId?: string | null;
}): Promise<ForeignName[]> {
  const mine = appNetwork(a);
  const db = getDb();
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
      // construction, so naming one would only leak their project name.
      .where(and(eq(appsTable.teamId, a.teamId), ne(appsTable.id, a.id)))
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
      .where(eq(databasesTable.teamId, a.teamId))
      .limit(MAX_NEIGHBOURS),
  ]);

  const out: ForeignName[] = [];
  const add = (
    name: string,
    network: string,
    serverId: string,
    where: string,
  ) => {
    if (!name) return;
    const sameNetwork = network === mine;
    const sameHost = serverId === a.serverId;
    // Reachable: same network name AND same machine. Anything else is a name this
    // app will not resolve, and the two reasons take different advice.
    if (sameNetwork && sameHost) return;
    out.push({
      name: name.toLowerCase(),
      network,
      where,
      why: sameNetwork ? "other-host" : "elsewhere",
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
