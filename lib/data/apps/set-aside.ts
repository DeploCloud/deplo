import "server-only";

import { connectAgent } from "../../infra/agent-client/connect";
import { getCurrentUser } from "../../auth/current-user";
import { recordActivity } from "../activity";
import { requireAppCapability } from "../node-access";
import { appOwnVolumeNames } from "../project-backup-descriptor";
import { getServerById } from "../servers/roster";
import { clusterMemberServerIds } from "../clusters/roster";
import { getAppById } from "./listing";
import { formatBytes } from "../../utils";

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
        of: c.of,
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
  const names = appOwnVolumeNames(app);
  if (names.length === 0 || !app.clusterId) return [];
  const servers = await clusterMemberServerIds(app.clusterId);
  const all = (
    await Promise.all(servers.map((s) => copiesOn(s, names)))
  ).flat();
  return all.sort((a, b) => b.at.localeCompare(a.at));
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
