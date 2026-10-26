import type { AgentUpdateDTO } from "@/lib/data/servers/agent-update-state";

/** One line for where a server's agent update stands; null when there is nothing to say. */
export function agentUpdateText(
  update: AgentUpdateDTO | null,
  usable: boolean,
  now: number = Date.now(),
  links = true,
): string | null {
  // Too old to link: nothing Deplo does reaches it (ADR-0040).
  if (!usable && !links) return "Unusable - reinstall its agent";
  const prefix = usable ? "" : "Unusable - ";
  if (!update) return usable ? null : `${prefix}Deplo is updating it`;
  if (update.running) return `${prefix}Updating the agent`;
  if (update.gaveUp) return `${prefix}Update failed (gave up after 24 h)`;
  const left = update.nextRetryAt ? Date.parse(update.nextRetryAt) - now : 0;
  const when =
    left <= 0 ? "retrying now" : `retrying in ${Math.ceil(left / 60_000)} min`;
  return update.failure === "busy"
    ? `${prefix}Waiting for a deploy to finish, ${when}`
    : `${prefix}Update failed, ${when}`;
}

/** The admin banner's line for the servers this Deplo refuses; one too old to link only comes back reinstalled. */
export function unusableAgentsMessage(
  servers: { name: string; links: boolean }[],
): string {
  if (servers.length === 1) {
    const [s] = servers;
    return s.links
      ? `${s.name} is unusable until its agent updates.`
      : `${s.name} is unusable until its agent is reinstalled.`;
  }
  return servers.every((s) => s.links)
    ? `${servers.length} servers are unusable until their agents update.`
    : `${servers.length} servers are unusable until their agents update or are reinstalled.`;
}
