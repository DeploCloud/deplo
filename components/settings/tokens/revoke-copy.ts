import type { TokenTeam } from "@/lib/data/tokens";

/**
 * What the Revoke dialog says, for an API token that may reach several teams.
 *
 * Revoking takes away THIS team's access and leaves the rest (`revokeToken`), so
 * the old single sentence — "it loses access immediately" — is false the moment
 * a token spans two teams. Shared by both dialogs that offer the button, because
 * the same action described two ways is how a UI teaches the wrong model.
 *
 * A token with no scope (`scoped: false`) reaches every team its creator belongs
 * to, live, with no per-team grant to remove: it really is revoked outright, and
 * keeps the sentence it always had.
 *
 * Connected clients (Settings → MCP) deliberately do NOT use this: that screen
 * speaks about the active team only, and never names the others.
 */
interface RevokeCopyInput {
  /** Every team the credential reaches, named. Empty when it is not scoped. */
  teams: TokenTeam[];
  activeTeamId: string;
  scoped: boolean;
}

/** "Acme", "Acme and Beta", "Acme, Beta and Gamma". */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function othersOf({ teams, activeTeamId, scoped }: RevokeCopyInput): string[] {
  if (!scoped) return [];
  // Revoking from OUTSIDE the credential's reach (your own token, seen from
  // another team on the tokens page) cuts it outright: there is no per-team
  // grant to hand back, so it gets the plain "gone" sentence.
  if (!teams.some((t) => t.id === activeTeamId)) return [];
  return teams.filter((t) => t.id !== activeTeamId).map((t) => t.name);
}

export function revokeTitle(name: string, input: RevokeCopyInput): string {
  const here = input.teams.find((t) => t.id === input.activeTeamId)?.name;
  return othersOf(input).length > 0 && here
    ? `Revoke ${name} from ${here}?`
    : `Revoke ${name}?`;
}

export function revokeDescription(input: RevokeCopyInput): string {
  const others = othersOf(input);
  if (others.length === 0)
    return "Every client using it loses access immediately, including any deploy hook that sends it. This can't be undone; create a new token if you still need one.";

  const here = input.teams.find((t) => t.id === input.activeTeamId)?.name;
  const where = here ? `to ${here}` : "to this team";
  return `It loses access ${where} immediately. It keeps working in ${joinNames(others)}, so anything using it there is unaffected.`;
}
