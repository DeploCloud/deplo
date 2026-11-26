import "server-only";

import { eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { clusters as clustersTable } from "../../db/schema/control-plane/clusters";
import { databases as databasesTable } from "../../db/schema/control-plane/databases";

import { connectAgent } from "../../infra/agent-client/connect";
import { getCurrentUser } from "../../auth/current-user";
import { recordActivity } from "../activity";
import { requireAppCapability } from "../node-access";
import {
  appHasFilesDir,
  appOwnVolumeNames,
} from "../project-backup-descriptor";
import { filesAsideOf } from "../clusters/copy-aside";
import { getServerById } from "../servers/roster";
import { clusterMemberServerIds } from "../clusters/roster";
import { getAppById } from "./listing";
import { loadAppGraph } from "../app-graph-load";
import { diskFull, FULL_SHARE } from "../backups/room";
import { formatBytes } from "../../utils";
import type { App } from "../../types/app";
import { dbVolumeHostName } from "../databases/stack";

// What a cluster server that came back held of an App and its copy may not have sent: set aside, never deleted.
// https://deplo.build/docs/operations/clusters/failover#set-aside-copies

export const SET_ASIDE_CAPABILITY = "volumes.set-aside";

export interface SetAsideCopyView {
  serverId: string;
  serverName: string;
  volumeName: string;
  /** The volume it is a copy of. */
  of: string;
  /** When its server came back and set it aside. */
  at: string;
  bytes: number;
}

/** The names an App's set-aside copies are copies of: its volumes, and its Files folder. */
function asideNames(app: App): string[] {
  const names = appOwnVolumeNames(app);
  return appHasFilesDir(app) ? [...names, filesAsideOf(app.slug)] : names;
}

async function copiesOn(
  serverId: string,
  names: string[],
): Promise<SetAsideCopyView[]> {
  try {
    const conn = await connectAgent(serverId);
    try {
      if (!(await conn.hello()).capabilities?.includes(SET_ASIDE_CAPABILITY))
        return [];
      const name = (await getServerById(serverId))?.name ?? serverId;
      return (await conn.setAsideCopies(names)).map((c) => ({
        serverId,
        serverName: name,
        volumeName: c.volumeName,
        of: c.of.endsWith(".files") ? "Files" : c.of,
        at: new Date(c.atMs || 0).toISOString(),
        bytes: c.bytes,
      }));
    } finally {
      conn.close();
    }
  } catch {
    // A server that does not answer lists nothing now; its copies stay where they are.
    return [];
  }
}

/** The dated copies the App's cluster servers set aside of its volumes, newest first. */
export async function listAppSetAsideCopies(
  appId: string,
): Promise<SetAsideCopyView[]> {
  const app = await getAppById(appId);
  if (!app) throw new Error("App not found");
  const names = asideNames(app);
  if (names.length === 0 || !app.clusterId) return [];
  const servers = await clusterMemberServerIds(app.clusterId);
  const all = (
    await Promise.all(servers.map((s) => copiesOn(s, names)))
  ).flat();
  return all.sort((a, b) => b.at.localeCompare(a.at));
}

/**
 * Deleting an App removes every copy its servers set aside of its data, under the delete's own gate, and says how many
 * went from where; a server that does not answer keeps its copies, and the line says so.
 */
export async function removeSetAsideCopiesOfDeleted(
  app: App,
): Promise<string | null> {
  const names = asideNames(app);
  if (names.length === 0 || !app.clusterId) return null;
  const gone = new Map<string, number>();
  const silent: string[] = [];
  for (const serverId of await clusterMemberServerIds(app.clusterId)) {
    const name = (await getServerById(serverId))?.name ?? serverId;
    try {
      const conn = await connectAgent(serverId);
      try {
        if (!(await conn.hello()).capabilities?.includes(SET_ASIDE_CAPABILITY))
          continue;
        for (const c of await conn.setAsideCopies(names))
          if ((await conn.removeSetAside(c.volumeName)).ok)
            gone.set(name, (gone.get(name) ?? 0) + 1);
          else silent.push(name);
      } finally {
        conn.close();
      }
    } catch {
      silent.push(name);
    }
  }
  const left = [...new Set(silent)];
  const note =
    left.length > 0
      ? ` ${left.join(" and ")} did not answer: what ${left.length === 1 ? "it holds" : "they hold"} of it goes once ${left.length === 1 ? "it answers" : "they answer"}.`
      : "";
  if (gone.size === 0) return note ? note.trim() : null;
  const n = [...gone.values()].reduce((a, b) => a + b, 0);
  const where = [...gone].map(([s, k]) => `${k} on ${s}`).join(", ");
  return `Removed ${n} set-aside ${n === 1 ? "copy" : "copies"} of ${app.name}'s data: ${where}.${note}`;
}

/** Removes one set-aside copy of the App's data, for good. */
export async function removeAppSetAsideCopy(
  appId: string,
  serverId: string,
  volumeName: string,
): Promise<boolean> {
  const { teamId } = await requireAppCapability(appId, "delete_backups");
  const user = (await getCurrentUser())!;
  const app = await getAppById(appId);
  if (!app) throw new Error("App not found");
  const copy = (await listAppSetAsideCopies(appId)).find(
    (c) => c.serverId === serverId && c.volumeName === volumeName,
  );
  if (!copy)
    throw new Error("That copy is not one of this App's set-aside copies.");
  const conn = await connectAgent(serverId);
  try {
    const res = await conn.removeSetAside(volumeName);
    if (!res.ok)
      throw new Error(res.error || "The server could not remove it.");
  } finally {
    conn.close();
  }
  await recordActivity(
    "app",
    `Removed the copy of ${app.name}'s data that ${copy.serverName} set aside on ${copy.at.slice(0, 16).replace("T", " ")} UTC (${formatBytes(copy.bytes)})`,
    user.name,
    app.id,
    teamId,
  );
  return true;
}

const DAY_MS = 24 * 60 * 60_000;

/** An App or database whose data its cluster servers may have set aside. */
interface AsideOwner {
  name: string;
  teamId: string;
  appId: string | null;
  databaseId: string | null;
  names: string[];
}

/** The volume a dated copy is a copy of, read from its own name, so two Apps' Files never share one "newest". */
const copyOf = (volumeName: string) =>
  volumeName.replace(/-aside-\d{8}T\d{6}Z$/, "");

/**
 * Keeps the newest set-aside copy of each owner's data on the server, and removes an older one after 7 days, or after
 * 1 once that server is past 80% used; one Activity line each.
 */
async function expireOn(
  serverId: string,
  owners: AsideOwner[],
  now: number,
): Promise<void> {
  const names = owners.flatMap((o) => o.names);
  if (names.length === 0) return;
  const full = diskFull(serverId);
  const before = now - (full ? 1 : 7) * DAY_MS;
  const newest = new Set<string>();
  const old = (await copiesOn(serverId, names))
    .sort((a, b) => b.at.localeCompare(a.at))
    .filter((c) => {
      const of = copyOf(c.volumeName);
      if (newest.has(of)) return Date.parse(c.at) < before;
      newest.add(of);
      return false;
    });
  if (old.length === 0) return;
  try {
    const conn = await connectAgent(serverId);
    try {
      for (const c of old) {
        const owner = owners.find((o) =>
          o.names.includes(copyOf(c.volumeName)),
        );
        if (!owner || !(await conn.removeSetAside(c.volumeName)).ok) continue;
        await recordActivity(
          owner.appId ? "app" : "database",
          `Removed the copy of ${owner.name}'s data that ${c.serverName} set aside on ${c.at.slice(0, 16).replace("T", " ")} UTC (${formatBytes(c.bytes)}): ` +
            (full
              ? `${c.serverName} is more than ${FULL_SHARE * 100}% full, and a newer copy is kept.`
              : "it was older than 7 days, and a newer copy is kept."),
          "Deplo",
          owner.appId,
          owner.teamId,
          null,
          owner.databaseId,
        );
      }
    } finally {
      conn.close();
    }
  } catch {
    // A server that does not answer keeps its copies until the next pass.
  }
}

/** The set-aside expiry for one App, run after each of its backups. */
export async function expireSetAsideCopies(
  appId: string,
  now = Date.now(),
): Promise<void> {
  const app = await loadAppGraph(appId).catch(() => null);
  if (!app?.clusterId) return;
  const owner = appOwner(app);
  for (const serverId of await clusterMemberServerIds(app.clusterId))
    await expireOn(serverId, [owner], now);
}

const appOwner = (app: App): AsideOwner => ({
  name: app.name,
  teamId: app.teamId,
  appId: app.id,
  databaseId: null,
  names: asideNames(app),
});

/**
 * The maintenance sweep's pass: every App and database of every cluster, backed up or not, on each of its servers
 * (c50: a database's copies, or an App's with no backup, were never expired).
 */
export async function expireAllSetAsideCopies(now = Date.now()): Promise<void> {
  const db = getDb();
  for (const { id } of await db
    .select({ id: clustersTable.id })
    .from(clustersTable)) {
    const owners: AsideOwner[] = [];
    for (const a of await db
      .select({ id: appsTable.id })
      .from(appsTable)
      .where(eq(appsTable.clusterId, id))) {
      const app = await loadAppGraph(a.id).catch(() => null);
      if (app) owners.push(appOwner(app));
    }
    for (const d of await db
      .select({
        id: databasesTable.id,
        name: databasesTable.name,
        teamId: databasesTable.teamId,
        host: databasesTable.host,
      })
      .from(databasesTable)
      .where(eq(databasesTable.clusterId, id)))
      owners.push({
        name: d.name,
        teamId: d.teamId,
        appId: null,
        databaseId: d.id,
        names: [dbVolumeHostName(d.host), filesAsideOf(d.host)],
      });
    for (const serverId of await clusterMemberServerIds(id))
      await expireOn(serverId, owners, now);
  }
}
