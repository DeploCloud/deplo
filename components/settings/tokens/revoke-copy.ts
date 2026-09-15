import type { TokenTeam } from "@/lib/data/tokens/reach";

interface RevokeCopyInput {
  teams: TokenTeam[];
  activeTeamId: string;
  scoped: boolean;
}

export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function othersOf({ teams, activeTeamId, scoped }: RevokeCopyInput): string[] {
  if (!scoped) return [];
  return teams.filter((t) => t.id !== activeTeamId).map((t) => t.name);
}

export function revokeDescription(input: RevokeCopyInput): string {
  const others = othersOf(input);
  const first =
    others.length > 0
      ? `Every client using it loses access immediately, in ${joinNames(others)} too.`
      : "Every client using it loses access immediately, including any deploy hook that sends it.";
  return `${first} This can't be undone.`;
}
