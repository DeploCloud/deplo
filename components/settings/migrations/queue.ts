import type { SourceKind } from "./sources";

export type TeamTarget = { kind: "existing"; teamId: string } | { kind: "new" };

export interface QueuedTeam {
  apiKey: string;
  sourceTeamId: string | null;
  name: string;
  image: string | null;
  target: TeamTarget;
  status: "waiting" | "done" | "skipped" | "stopped" | "failed";
}

export interface SourceTeam {
  platform: SourceKind;
  teamId: string | null;
  teamName: string | null;
  otherTeams: string[] | null;
}

export function teamLabel(t: SourceTeam): string {
  return t.teamName?.trim() || t.teamId || "";
}

export function sameTeamName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function defaultTarget(
  name: string,
  teams: { id: string; name: string }[],
): TeamTarget {
  const home = name.trim()
    ? teams.find((t) => sameTeamName(t.name, name))
    : undefined;
  return home ? { kind: "existing", teamId: home.id } : { kind: "new" };
}

export function addTeam(
  queue: QueuedTeam[],
  team: SourceTeam,
  apiKey: string,
  teams: { id: string; name: string }[] = [],
): { queue: QueuedTeam[]; error: null } | { queue: null; error: string } {
  const key = apiKey.trim();
  if (!key) return { queue: null, error: "Paste the key first." };
  if (queue.some((q) => q.apiKey === key))
    return { queue: null, error: "That key is already on the list." };
  if (team.teamId && queue.some((q) => q.sourceTeamId === team.teamId))
    return {
      queue: null,
      error: `${teamLabel(team)} is already on the list. Another team needs its own token.`,
    };
  const name = teamLabel(team);
  return {
    error: null,
    queue: [
      ...queue,
      {
        apiKey: key,
        sourceTeamId: team.teamId,
        name,
        image: null,
        target: defaultTarget(team.teamName?.trim() ? name : "", teams),
        status: "waiting",
      },
    ],
  };
}

export function retarget(
  queue: QueuedTeam[],
  i: number,
  target: TeamTarget,
): QueuedTeam[] {
  return queue.map((q, j) => (j === i ? { ...q, target } : q));
}

export function uncoveredTeams(
  all: string[] | null,
  queue: QueuedTeam[],
): string[] {
  if (!all) return [];
  const have = new Set(
    queue.map((q) => q.name.trim().toLowerCase()).filter(Boolean),
  );
  return all.filter((n) => n.trim() && !have.has(n.trim().toLowerCase()));
}

export function teamsAfter(queue: QueuedTeam[], at: number): number {
  return Math.max(0, queue.length - at - 1);
}
