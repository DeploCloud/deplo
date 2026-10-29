import type { AgentUpdateDTO } from "@/lib/data/servers/agent-update-state";
import type { AgentReach } from "@/lib/version";

/** One line for where a server's agent update stands; null when there is nothing to say. */
export function agentUpdateText(
  update: AgentUpdateDTO | null,
  reach: AgentReach,
  now: number = Date.now(),
): string | null {
  // It never reaches this Deplo (ADR-0041): nothing Deplo does updates it.
  if (reach === "reinstall") return "Unusable - reinstall its server agent";
  const prefix = reach === "usable" ? "" : "Unusable - ";
  if (!update) return prefix ? `${prefix}Deplo is updating it` : null;
  if (update.running) return `${prefix}Updating the server agent`;
  if (update.gaveUp) return `${prefix}Update failed (gave up after 24 h)`;
  const left = update.nextRetryAt ? Date.parse(update.nextRetryAt) - now : 0;
  const when =
    left <= 0 ? "retrying now" : `retrying in ${Math.ceil(left / 60_000)} min`;
  return update.failure === "busy"
    ? `${prefix}Waiting for a deploy to finish, ${when}`
    : `${prefix}Update failed, ${when}`;
}

/** The admin banner's line for the servers this Deplo refuses. */
export function unusableAgentsMessage(
  servers: { name: string; reach: Exclude<AgentReach, "usable"> }[],
): string {
  if (servers.length === 1) {
    const [s] = servers;
    return s.reach === "updatable"
      ? `${s.name} is unusable until its server agent updates.`
      : `${s.name} is unusable until its server agent is reinstalled.`;
  }
  const until = servers.every((s) => s.reach === "updatable")
    ? "update"
    : servers.every((s) => s.reach === "reinstall")
      ? "are reinstalled"
      : "update or are reinstalled";
  return `${servers.length} servers are unusable until their server agents ${until}.`;
}
