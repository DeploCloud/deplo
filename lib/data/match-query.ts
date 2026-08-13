/**
 * The one rule for "does this thing match what the user typed".
 *
 * Its own module because both sides of the search use it and they must never
 * drift: `listApps` / `listDatabases` filter one team with it, `search` spans
 * every team the caller can reach with it. No imports on purpose - a matcher
 * that pulls in the data layer could not be used inside the data layer.
 */

/**
 * Fold a value down to what a person means when they type a name.
 *
 * "better auth" has to find `better-auth-docs`, and a pasted `prj_9f2…` has to
 * find itself, so separators are dropped on BOTH sides rather than matched: one
 * normalized substring test then covers the name, the slug and the id, and
 * there is no second matching rule to keep in sync.
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
