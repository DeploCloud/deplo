import type { TokenTeam } from "@/lib/data/tokens";

/**
 * What the Revoke dialog says, for an API token that may reach several teams.
 *
 * Revoke deletes the credential everywhere (`revokeToken`), so the sentence
 * never promises a survivor. What it does add, when the token also works in
 * other teams, is WHICH ones: the person pressing the button is about to stop
 * automation they may not be able to see, and a blast radius nobody is told
 * about is how a revoke becomes somebody else's outage.
 *
 * Shared by both dialogs that offer the button, because the same action
 * described two ways is how a UI teaches the wrong model.
 *
 * A token with no scope (`scoped: false`) reaches every team its creator belongs
 * to, live, with no stored set to name: it gets the plain sentence.
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
  return teams.filter((t) => t.id !== activeTeamId).map((t) => t.name);
}

export function revokeDescription(input: RevokeCopyInput): string {
  const others = othersOf(input);
  const first =
    others.length > 0
      ? `Every client using it loses access immediately, in ${joinNames(others)} too.`
      : "Every client using it loses access immediately, including any deploy hook that sends it.";
  return `${first} This can't be undone; create a new token if you still need one.`;
}
