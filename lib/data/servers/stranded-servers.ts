import "server-only";

import { requireInstanceAdmin } from "../../membership";
import { agentUsable, reportedAgentVersion } from "../../version";
import { readReleaseDeclaration } from "../update-stops/declaration";
import { listAllServers } from "./roster";

export interface StrandedServer {
  id: string;
  name: string;
  version: string | null;
}

/** The agent floor a published Deplo declares, read off its tag. */
export async function targetAgentMin(version: string): Promise<string | null> {
  return (await readReleaseDeclaration(version))?.agentMin ?? null;
}

/** Offline servers whose agent the new Deplo refuses: unusable until they come back and update. */
export async function strandedByPanelUpdate(
  version: string,
): Promise<StrandedServer[]> {
  await requireInstanceAdmin();
  const min = await targetAgentMin(version);
  if (!min) return [];
  return (await listAllServers())
    .filter(
      (s) =>
        !s.importOnly &&
        Boolean(s.agent?.certFingerprint) &&
        (s.status === "offline" || s.status === "error") &&
        !agentUsable(reportedAgentVersion(s), min),
    )
    .map((s) => ({ id: s.id, name: s.name, version: reportedAgentVersion(s) }));
}
