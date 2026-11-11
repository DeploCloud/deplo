/** Who reaches a database through Deplo's relay, as one short sentence for the database page (#200). */
export function relayNoticeText(appNames: string[]): string | null {
  const names = [...new Set(appNames)].sort();
  if (names.length === 0) return null;
  const shown = names.slice(0, 3).join(", ");
  const who =
    names.length > 3 ? `${shown} and ${names.length - 3} more` : shown;
  return `${who} reach${names.length === 1 ? "es" : ""} this database through Deplo's relay. It is faster on the same server.`;
}
