import "server-only";

import { listAllServers } from "../servers/roster";

export interface StopServer {
  id: string;
  name: string;
}

export interface StopCondition {
  met: boolean;
  // The enrolled servers that have not connected to Deplo yet.
  waitingOn?: StopServer[];
}

/** What must hold before this release counts as passed, when it is an update stop (ADR-0041). */
export async function thisStopsCondition(): Promise<StopCondition> {
  const waitingOn = (await listAllServers())
    .filter(
      (s) =>
        Boolean(s.agent?.certFingerprint) && !s.importOnly && !s.firstLinkedAt,
    )
    .map((s) => ({ id: s.id, name: s.name }));
  return { met: waitingOn.length === 0, waitingOn };
}
