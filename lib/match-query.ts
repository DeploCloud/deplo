export function foldQuery(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[^a-z0-9]/g, "");
}

export function matchesQuery(query: string, ...fields: string[]): boolean {
  const needle = foldQuery(query);
  if (!needle) return false;
  return fields.some((f) => foldQuery(f).includes(needle));
}

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
