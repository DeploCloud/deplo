import "server-only";

import { requireInstanceAdmin } from "../../membership";
import { DEPLO_REPO, agentUsable, reportedAgentVersion } from "../../version";
import { listAllServers } from "./roster";

export interface StrandedServer {
  id: string;
  name: string;
  version: string | null;
}

/** The agent floor a published Deplo declares, read off its tag without the API budget. */
export async function targetAgentMin(version: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://raw.githubusercontent.com/${DEPLO_REPO}/v${version}/package.json`,
      {
        signal: AbortSignal.timeout(5000),
        cache: "force-cache",
        next: { revalidate: 3600 },
      },
    );
    if (!res.ok) return null;
    const min = ((await res.json()) as { deplo?: { agentMin?: unknown } }).deplo
      ?.agentMin;
    return typeof min === "string" ? min : null;
  } catch {
    return null;
  }
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
