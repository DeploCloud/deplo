import "server-only";

import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { backupDestination as destTable } from "../../db/schema/control-plane/backups";
import { databases as databasesTable } from "../../db/schema/control-plane/databases";
import { dispatchAlert } from "../../notify/dispatch";
import type { Cluster } from "../../types/cluster";
import { joinNames } from "../../utils";
import { recordActivity } from "../activity";
import { recordLeftBehindRun } from "../backups/left-behind";
import { getServerById } from "../servers/roster";

// A server presumed gone came back and stopped its copies of what had moved (spec #176): one Activity entry
// and one alert per team, each naming only that team's own Apps and databases, and what was saved of them.

type Kind = "app" | "database";

interface Workload {
  kind: Kind;
  id: string;
  name: string;
  teamId: string;
  app: { id: string; slug: string } | null;
}

type Row = Record<string, unknown>;

function rows(d: Row, list: string): Row[] {
  const v = d[list];
  if (!Array.isArray(v)) return [];
  return v.filter(
    (w): w is Row =>
      Boolean(w) &&
      typeof w === "object" &&
      (w.kind === "app" || w.kind === "database") &&
      typeof w.workloadId === "string",
  );
}

const keyOf = (w: Row) => `${String(w.kind)}/${String(w.workloadId)}`;

/** Every workload of this cluster the event names, by kind and id; one of another cluster is not in it. */
async function namedWorkloads(
  clusterId: string,
  named: Row[],
): Promise<Map<string, Workload>> {
  const db = getDb();
  const ids = (kind: Kind) => [
    ...new Set(
      named.filter((w) => w.kind === kind).map((w) => w.workloadId as string),
    ),
  ];
  const [appIds, dbIds] = [ids("app"), ids("database")];
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
        .select({
          id: databasesTable.id,
          name: databasesTable.name,
          teamId: databasesTable.teamId,
        })
        .from(databasesTable)
        .where(
          and(
            eq(databasesTable.clusterId, clusterId),
            inArray(databasesTable.id, dbIds),
          ),
        )
    : [];
  const out = new Map<string, Workload>();
  for (const a of apps)
    out.set(`app/${a.id}`, {
      kind: "app",
      id: a.id,
      name: a.name,
      teamId: a.teamId,
      app: { id: a.id, slug: a.slug },
    });
  for (const r of dbs)
    out.set(`database/${r.id}`, {
      kind: "database",
      id: r.id,
      name: r.name,
      teamId: r.teamId,
      app: null,
    });
  return out;
}

const iso = (v: unknown): string | null =>
  typeof v === "string" && !Number.isNaN(Date.parse(v))
    ? new Date(v).toISOString()
    : null;

/** Lists what the member saved under the workload's backups; false when the file is not where it should be. */
async function listSaved(
  w: Workload,
  member: string,
  s: Row,
): Promise<boolean> {
  const savedAt = iso(s.at) ?? new Date().toISOString();
  if (typeof s.ref !== "string" || typeof s.objectKey !== "string")
    return false;
  const id = await recordLeftBehindRun({
    teamId: w.teamId,
    kind: w.kind,
    targetId: w.id,
    destinationId: s.ref,
    objectKey: s.objectKey,
    sizeBytes: Number(s.sizeBytes) || 0,
    decryptedSizeBytes: Number(s.decryptedSizeBytes) || null,
    sha256: typeof s.sha256 === "string" && s.sha256 ? s.sha256 : null,
    serverId: member,
    failedOverAt: iso(s.failedOverAt) ?? savedAt,
    savedAt,
  });
  return id !== null;
}

/** Why a member kept what it held, in the words the user reads. */
async function whyKept(w: Workload, server: string, k: Row): Promise<string> {
  if (k.reason === "store_elsewhere") {
    const [dest] =
      typeof k.ref === "string"
        ? await getDb()
            .select({ serverId: destTable.serverId })
            .from(destTable)
            .where(and(eq(destTable.id, k.ref), eq(destTable.teamId, w.teamId)))
            .limit(1)
        : [];
    const on =
      (dest?.serverId && (await getServerById(dest.serverId))?.name) ||
      "another server";
    return `its backups are kept on ${on}, which ${server} cannot reach on its own`;
  }
  if (k.reason === "backup_failed") {
    const error = typeof k.error === "string" ? k.error.trim() : "";
    return error
      ? `the backup failed (${error.slice(0, 200)})`
      : "the backup failed";
  }
  return "the cluster had no backup destination for it";
}

/** One return of a member: what it stopped and what it saved, said once to each team that owns some of it. */
export async function applyMemberReturned(
  cluster: Cluster,
  seq: number,
  d: Record<string, unknown>,
): Promise<void> {
  if (typeof d.member !== "string") return;
  const member = d.member;
  const [stopped, saved, kept] = [
    rows(d, "stopped"),
    rows(d, "saved"),
    rows(d, "kept"),
  ];
  const known = await namedWorkloads(cluster.id, [
    ...stopped,
    ...saved,
    ...kept,
  ]);
  const own = (list: Row[], teamId: string) =>
    list.flatMap((r) => {
      const w = known.get(keyOf(r));
      return w && w.teamId === teamId ? [{ w, r }] : [];
    });
  const teams = new Set(
    stopped.flatMap((r) => known.get(keyOf(r))?.teamId ?? []),
  );
  if (teams.size === 0) return;
  const server = (await getServerById(member))?.name ?? "A server";
  const title = `${server} is back in cluster ${cluster.name}`;
  for (const teamId of teams) {
    const mine = own(stopped, teamId).map((s) => s.w);
    const names = mine.map((w) => w.name).sort((a, b) => a.localeCompare(b));
    const parts = [
      names.length === 1
        ? `Its copy of ${names[0]} was stopped: ${names[0]} runs on another server now.`
        : `Its copies of ${joinNames(names)} were stopped: they run on other servers now.`,
    ];
    const listed: string[] = [];
    for (const { w, r } of own(saved, teamId)) {
      if (await listSaved(w, member, r)) listed.push(w.name);
      else
        parts.push(
          `What it still held of ${w.name} was saved, but Deplo could not match the file to ${w.name}'s backups, so it is not listed.`,
        );
    }
    if (listed.length > 0)
      parts.splice(
        1,
        0,
        `What it still held of ${joinNames(listed.sort((a, b) => a.localeCompare(b)))} was saved as ${listed.length === 1 ? "a backup" : "backups"}, labelled "Left on ${server}".`,
      );
    for (const { w, r } of own(kept, teamId).sort((a, b) =>
      a.w.name.localeCompare(b.w.name),
    ))
      parts.push(
        `What it still held of ${w.name} could not be saved as a backup, so it stays on ${server}: ${await whyKept(w, server, r)}.`,
      );
    const body = parts.join(" ");
    const only = mine.length === 1 ? mine[0]!.app : null;
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
