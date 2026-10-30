import type { AgentReach } from "./version";

/** What to check when a server is offline, however Deplo reaches it (ADR-0040). */
export const LINK_OFFLINE_MESSAGE =
  "Check that the machine is on and connected to the internet.";

/** A server enrolled but never connected (ADR-0041): curated around the panel's name alone, never a port. */
export function cantReachDeploMessage(panelHost: string | null): string {
  const at = panelHost ? ` at ${panelHost}` : "";
  return `This server can't reach Deplo${at}. Check that it's connected to the internet.`;
}

/** A server that can never connect: left behind at an update stop, or its server agent too old to (ADR-0041). */
export const AGENT_REINSTALL_MESSAGE =
  "This server can't be used until its server agent is reinstalled. " +
  "An instance admin can do it from the server's Advanced tab.";

/** What a server no update reaches is told instead of one; null when Deplo can update it. */
export function stuckAgentMessage(reach: AgentReach): string | null {
  if (reach === "reinstall") return AGENT_REINSTALL_MESSAGE;
  if (reach === "unlinked") return cantReachDeploMessage(null);
  return null;
}
