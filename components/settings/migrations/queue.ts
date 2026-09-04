import type { SourceKind } from "./sources";

/**
 * The teams of one panel waiting their turn. A token reads exactly ONE team on
 * both products, so bringing several over is several tokens and several runs -
 * this is the list, and the wizard walks it.
 */

export interface QueuedTeam {
  /** The panel's key for this team. Emptied when its turn is over. */
  apiKey: string;
  /** The team's own id over there, which is what a duplicate is judged on. Null
   *  from a panel that would not say - then the key itself is the only tell. */
  sourceTeamId: string | null;
  /** The source team's name, which is also the Deplo team it lands in. */
  name: string;
  /** Its picture on the panel, drawn instead of the generic mark. Null when the
   *  panel keeps none - a Coolify team has no picture at all. */
  avatarUrl: string | null;
  status: "waiting" | "done" | "stopped" | "failed";
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

/**
 * Add one token to the list, or say why not. The same team twice would import it
 * twice, and a panel that will not name its teams leaves the key as the only tell.
 */
export function addTeam(
  queue: QueuedTeam[],
  team: SourceTeam,
  apiKey: string,
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
  return {
    error: null,
    queue: [
      ...queue,
      {
        apiKey: key,
        sourceTeamId: team.teamId,
        name: teamLabel(team),
        avatarUrl: team.teamAvatarUrl,
        status: "waiting",
      },
    ],
  };
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
