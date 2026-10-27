import type { AgentUpdateDTO } from "@/lib/data/servers/agent-update-state";
import type { AgentReach } from "@/lib/version";

/** One line for where a server's agent update stands; null when there is nothing to say. `now` null: no countdown yet. */
export function agentUpdateText(
  update: AgentUpdateDTO | null,
  reach: AgentReach,
  now: number | null,
): string | null {
  // Too old to link: nothing Deplo does reaches it (ADR-0040).
  if (reach === "reinstall") return "Unusable - reinstall its server agent";
  const prefix = reach === "usable" ? "" : "Unusable - ";
  if (!update) return prefix ? `${prefix}Deplo is updating it` : null;
  if (update.running) return `${prefix}Updating the agent`;
  if (update.gaveUp) return `${prefix}Update failed (gave up after 24 h)`;
  const what =
    update.failure === "busy"
      ? "Waiting for a deploy to finish"
      : "Update failed";
  if (!update.nextRetryAt) return `${prefix}${what}, retrying now`;
  if (now === null) return `${prefix}${what}`;
  const left = Date.parse(update.nextRetryAt) - now;
  const when =
    left <= 0 ? "retrying now" : `retrying in ${Math.ceil(left / 60_000)} min`;
  return `${prefix}${what}, ${when}`;
}

/** The admin banner's line for the servers this Deplo refuses; one too old to link only comes back reinstalled. */
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
