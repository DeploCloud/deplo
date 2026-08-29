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

/**
 * How WELL a query matched: 0 exact, 1 prefix, 2 substring, 3 not at all. The
 * gate stays {@link matchesQuery}; this only orders what it let through.
 */
export function matchRank(query: string, ...fields: string[]): 0 | 1 | 2 | 3 {
  const needle = foldQuery(query);
  if (!needle) return 3;
  let best: 0 | 1 | 2 | 3 = 3;
  for (const f of fields) {
    const h = foldQuery(f);
    const r =
      h === needle ? 0 : h.startsWith(needle) ? 1 : h.includes(needle) ? 2 : 3;
    if (r < best) best = r;
  }
  return best;
}
