import "server-only";

import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { databases as databasesTable } from "../../db/schema/control-plane/databases";
import { dispatchAlert } from "../../notify/dispatch";
import type { Cluster } from "../../types/cluster";
import { joinNames } from "../../utils";
import { recordActivity } from "../activity";
import { getServerById } from "../servers/roster";

// A server presumed gone came back and stopped its copies of what had moved (spec #176): one Activity entry
// and one alert per team, each naming only that team's own Apps and databases.

interface Stopped {
  name: string;
  teamId: string;
  app: { id: string; slug: string } | null;
}

function ids(d: Record<string, unknown>, kind: string): string[] {
  if (!Array.isArray(d.stopped)) return [];
  return d.stopped
    .filter(
      (w): w is Record<string, unknown> => Boolean(w) && typeof w === "object",
    )
    .filter((w) => w.kind === kind && typeof w.workloadId === "string")
    .map((w) => w.workloadId as string);
}

async function stoppedWorkloads(
  clusterId: string,
  d: Record<string, unknown>,
): Promise<Stopped[]> {
  const db = getDb();
  const [appIds, dbIds] = [ids(d, "app"), ids(d, "database")];
  const apps = appIds.length
    ? await db
        .select({
          id: appsTable.id,
          name: appsTable.name,
          slug: appsTable.slug,
          teamId: appsTable.teamId,
        })
        .from(appsTable)
        .where(
          and(
            eq(appsTable.clusterId, clusterId),
            inArray(appsTable.id, appIds),
          ),
        )
    : [];
  const dbs = dbIds.length
    ? await db
        .select({ name: databasesTable.name, teamId: databasesTable.teamId })
        .from(databasesTable)
        .where(
          and(
            eq(databasesTable.clusterId, clusterId),
            inArray(databasesTable.id, dbIds),
          ),
        )
    : [];
  return [
    ...apps.map((a) => ({
      name: a.name,
      teamId: a.teamId,
      app: { id: a.id, slug: a.slug },
    })),
    ...dbs.map((r) => ({ name: r.name, teamId: r.teamId, app: null })),
  ];
}

/** One return of a member: what it stopped, said once to each team that owns some of it. */
export async function applyMemberReturned(
  cluster: Cluster,
  seq: number,
  d: Record<string, unknown>,
): Promise<void> {
  if (typeof d.member !== "string") return;
  const stopped = await stoppedWorkloads(cluster.id, d);
  if (stopped.length === 0) return;
  const server = (await getServerById(d.member))?.name ?? "A server";
  const byTeam = new Map<string, Stopped[]>();
  for (const s of stopped)
    byTeam.set(s.teamId, [...(byTeam.get(s.teamId) ?? []), s]);
  const title = `${server} is back in cluster ${cluster.name}`;
  for (const [teamId, own] of byTeam) {
    const names = own.map((s) => s.name).sort((a, b) => a.localeCompare(b));
    // ponytail: ticket #206 adds what was saved as a backup to this sentence.
    const body =
      names.length === 1
        ? `Its copy of ${names[0]} was stopped: ${names[0]} runs on another server now.`
        : `Its copies of ${joinNames(names)} were stopped: they run on other servers now.`;
    const only = own.length === 1 ? own[0]!.app : null;
    await recordActivity(
      "server",
      `${title}. ${body}`,
      "Deplo",
      only?.id ?? null,
      teamId,
    );
    dispatchAlert({
      teamId,
      key: "cluster_member_returned",
      dedupe: {
        id: `return:${cluster.id}:${seq}:${teamId}`,
        state: "returned",
      },
      title,
      body,
      path: only ? `/apps/${only.slug}` : "/activity",
      appId: only?.id ?? null,
    });
  }
}
