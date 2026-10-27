import "server-only";

import { listAllServers } from "../servers/roster";

export interface StopServer {
  id: string;
  name: string;
}

export interface StopCondition {
  met: boolean;
  // Enrolled servers that have not connected to Deplo yet, and those an instance admin left behind.
  waitingOn?: StopServer[];
  leftBehind?: StopServer[];
}

/** What must hold before this release counts as passed, when it is an update stop (ADR-0041). */
export async function thisStopsCondition(): Promise<StopCondition> {
  const unlinked = (await listAllServers()).filter(
    (s) =>
      Boolean(s.agent?.certFingerprint) && !s.importOnly && !s.firstLinkedAt,
  );
  const ref = (s: StopServer) => ({ id: s.id, name: s.name });
  const waitingOn = unlinked.filter((s) => !s.leftBehindAt).map(ref);
  const leftBehind = unlinked.filter((s) => s.leftBehindAt).map(ref);
  return { met: waitingOn.length === 0, waitingOn, leftBehind };
}
