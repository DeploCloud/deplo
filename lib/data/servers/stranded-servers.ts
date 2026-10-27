import "server-only";

import { hasLinked } from "../../infra/agent-link/registry";
import { requireInstanceAdmin } from "../../membership";
import {
  DEPLO_REPO,
  LINK_ONLY,
  agentReach,
  reportedAgentVersion,
} from "../../version";
import { listAllServers } from "./roster";

export interface StrandedServer {
  id: string;
  name: string;
  version: string | null;
  /** The new Deplo cannot reach it at all: only reinstalling its server agent brings it back. */
  reinstall: boolean;
}

interface TargetPin {
  agentMin: string | null;
  linkOnly: boolean;
}

/** What a published Deplo declares about its agents, read off its tag without the API budget. */
async function targetPin(version: string): Promise<TargetPin | null> {
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
    const pin = (
      (await res.json()) as {
        deplo?: { agentMin?: unknown; linkOnly?: unknown };
      }
    ).deplo;
    return {
      agentMin: typeof pin?.agentMin === "string" ? pin.agentMin : null,
      linkOnly: pin?.linkOnly === true,
    };
  } catch {
    return null;
  }
}

/** The agent floor a published Deplo declares. */
export async function targetAgentMin(version: string): Promise<string | null> {
  return (await targetPin(version))?.agentMin ?? null;
}

/**
 * Servers the new Deplo cannot use: offline ones below its floor, and, when it stops
 * dialing servers, every one that has not linked to this Deplo since it started.
 */
export async function strandedByPanelUpdate(
  version: string,
): Promise<StrandedServer[]> {
  await requireInstanceAdmin();
  const target = await targetPin(version);
  if (!target) return [];
  const stopsDialing = target.linkOnly && !LINK_ONLY;
  return (await listAllServers()).flatMap((s) => {
    if (s.importOnly || !s.agent?.certFingerprint) return [];
    const unlinked = stopsDialing && !hasLinked(s.id);
    const reach = target.agentMin ? agentReach(s, target.agentMin) : "usable";
    const belowFloor =
      (s.status === "offline" || s.status === "error") && reach !== "usable";
    if (!unlinked && !belowFloor) return [];
    return [
      {
        id: s.id,
        name: s.name,
        version: reportedAgentVersion(s),
        reinstall: unlinked || (target.linkOnly && reach === "reinstall"),
      },
    ];
  });
}
