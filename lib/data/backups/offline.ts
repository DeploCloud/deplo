import "server-only";

import { LINK_OFFLINE_MESSAGE } from "../../agent-reachability";
import { AgentOfflineError } from "../../infra/agent-client/errors";
import { getServerById } from "../servers/roster";

/** The server of a backup that did not answer, by name, and whether it is the backup's source or its destination. */
export async function backupServerOffline(
  e: unknown,
  sourceServerId: string,
): Promise<string | null> {
  if (!(e instanceof AgentOfflineError) || e.outOfReach) return null;
  const name = (await getServerById(e.serverId))?.name ?? "A server";
  const role = e.serverId === sourceServerId ? "source" : "destination";
  return `${name}, this backup's ${role}, is offline. ${LINK_OFFLINE_MESSAGE}`;
}
