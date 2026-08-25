/**
 * The one rule for "does this thing match what the user typed".
 */

/**
 * Fold a value down to what a person means when they type a name.
 */
export function foldQuery(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Does any of `fields` contain `query`, ignoring case and separators? */
export function matchesQuery(query: string, ...fields: string[]): boolean {
  const needle = foldQuery(query);
  if (!needle) return false;
  return fields.some((f) => foldQuery(f).includes(needle));
}
