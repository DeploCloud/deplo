/** Who reaches a database through Deplo's relay, as one short sentence for the database page (#200). */
export function relayNoticeText(appNames: string[]): string | null {
  const names = [...new Set(appNames)].sort();
  if (names.length === 0) return null;
  const shown = names.slice(0, 3).join(", ");
  const who =
    names.length > 3 ? `${shown} and ${names.length - 3} more` : shown;
  return `${who} reach${names.length === 1 ? "es" : ""} this database through Deplo's relay. It is faster on the same server.`;
}

/** The Environment field's tooltip: on a cluster a name follows the database to whichever server runs it. */
export function environmentReachNote(onCluster: boolean): string {
  return onCluster
    ? "Apps reach this database by name only from the same environment, on any server of the cluster."
    : "Apps reach this database by name only from the same environment and the same server: a network does not span machines.";
}

/** The same rule where the card cannot tell a server from a cluster. */
export const MOVE_ENVIRONMENT_NOTE =
  "Apps reach a database by name only from the same environment, on the same server or cluster";
