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
  if (reach === "unlinked")
    return "Unusable - it hasn't connected to Deplo yet";
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

type Unusable = Exclude<AgentReach, "usable">;

const UNTIL: Record<Unusable, string> = {
  updatable: "update",
  reinstall: "are reinstalled",
  unlinked: "connect to Deplo",
};

/** The admin banner's line for the servers this Deplo refuses. */
export function unusableAgentsMessage(
  servers: { name: string; reach: Unusable }[],
): string {
  if (servers.length === 1) {
    const [s] = servers;
    return {
      updatable: `${s.name} is unusable until its server agent updates.`,
      reinstall: `${s.name} is unusable until its server agent is reinstalled.`,
      unlinked: `${s.name} hasn't connected to Deplo yet.`,
    }[s.reach];
  }
  const reaches = (["updatable", "reinstall", "unlinked"] as const).filter(
    (r) => servers.some((s) => s.reach === r),
  );
  if (reaches.length === 1 && reaches[0] === "unlinked")
    return `${servers.length} servers haven't connected to Deplo yet.`;
  const until = reaches.map((r) => UNTIL[r]);
  const last = until.pop()!;
  const joined = until.length ? `${until.join(", ")} or ${last}` : last;
  return `${servers.length} servers are unusable until their server agents ${joined}.`;
}
