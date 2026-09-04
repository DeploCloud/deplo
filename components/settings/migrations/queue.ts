import type { SourceKind } from "./sources";

/**
 * The teams of one panel waiting their turn. A token reads exactly ONE team on
 * both products, so bringing several over is several tokens and several runs -
 * this is the list, and the wizard walks it.
 */

/** Where a source team lands: a team that exists, or one made for it at Start. */
export type TeamTarget = { kind: "existing"; teamId: string } | { kind: "new" };

export interface QueuedTeam {
  /** The panel's key for this team. Emptied when its turn is over. */
  apiKey: string;
  /** The team's own id over there, which is what a duplicate is judged on. Null
   *  from a panel that would not say - then the key itself is the only tell. */
  sourceTeamId: string | null;
  /** The source team's name, which a new team here is named after. */
  name: string;
  /** Its picture on the panel, drawn instead of the generic mark. Null when the
   *  panel keeps none - a Coolify team has no picture at all. */
  avatarUrl: string | null;
  /** The Deplo team it lands in. */
  target: TeamTarget;
  status: "waiting" | "done" | "skipped" | "stopped" | "failed";
}

/** What `identifyMigrationSource` answers. */
export interface SourceTeam {
  platform: SourceKind;
  teamId: string | null;
  teamName: string | null;
  teamAvatarUrl: string | null;
  otherTeams: string[] | null;
}

/** A team with no name is still a team: the id, or the panel's own word. */
export function teamLabel(t: SourceTeam): string {
  return t.teamName?.trim() || t.teamId || "that team";
}

/** Two names for one team, whatever anyone typed around them. */
export function sameTeamName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Where a source team lands unless somebody says otherwise: the team here of
 * the same name, else one made for it - the separation they had over there.
 */
export function defaultTarget(
  name: string,
  teams: { id: string; name: string }[],
): TeamTarget {
  const home = name.trim()
    ? teams.find((t) => sameTeamName(t.name, name))
    : undefined;
  return home ? { kind: "existing", teamId: home.id } : { kind: "new" };
}

/**
 * Add one token to the list, or say why not. The same team twice would import it
 * twice, and a panel that will not name its teams leaves the key as the only tell.
 */
export function addTeam(
  queue: QueuedTeam[],
  team: SourceTeam,
  apiKey: string,
  /** The teams this person may land a migration in, for the default. */
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
        avatarUrl: team.teamAvatarUrl,
        target: defaultTarget(team.teamName?.trim() ? name : "", teams),
        status: "waiting",
      },
    ],
  };
}

/** The same list with team `i` landing somewhere else. */
export function retarget(
  queue: QueuedTeam[],
  i: number,
  target: TeamTarget,
): QueuedTeam[] {
  return queue.map((q, j) => (j === i ? { ...q, target } : q));
}

/**
 * The panel's teams no token here covers yet. Empty when the panel cannot say,
 * which on Coolify it never can - there the wizard asks instead of listing.
 */
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

/** How many teams are still behind the one whose turn it is. */
export function teamsAfter(queue: QueuedTeam[], at: number): number {
  return Math.max(0, queue.length - at - 1);
}
