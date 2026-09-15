import "server-only";

import { and, asc, eq, isNull, ne, or } from "drizzle-orm";

import { getDb } from "../db/client";
import { apps as appsTable } from "../db/schema/control-plane/apps";
import { databases as databasesTable } from "../db/schema/control-plane/databases";
import {
  environments as environmentsTable,
  projects as projectsTable,
} from "../db/schema/control-plane/projects";
import { composeClaimedNames } from "../deploy/compose-lint/networks";
import { appNetwork } from "../deploy/network";
import { stackName } from "../deploy/deploy-key";
import type { Neighbour } from "../deploy/cross-network";

const MAX_NEIGHBOURS = 200;

export async function neighboursForApp(a: {
  id: string;
  serverId: string;
  teamId: string;
  environmentId?: string | null;
}): Promise<Neighbour[]> {
  const mine = appNetwork(a);
  const db = getDb();
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

function placeLabel(project: string | null, env: string | null): string {
  return project && env ? `${project} / ${env}` : "the team's top level";
}

export function redactNeighbours(list: Neighbour[]): Neighbour[] {
  return list.map((n) => ({ ...n, where: "another part of this team" }));
}
