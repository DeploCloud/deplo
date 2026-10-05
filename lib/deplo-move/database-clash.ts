// A database answers at `db-<slug>`, unique per server only: two old servers can each have one, and one server here cannot.
export interface ClashServer {
  id: string;
  name: string;
  databaseHosts?: { id: string; name: string; host: string }[];
}

function listOf(names: string[], last: string): string {
  return names.length < 2
    ? names.join("")
    : `${names.slice(0, -1).join(", ")} ${last} ${names.at(-1)}`;
}

// One sentence per database address that two old servers would bring onto one server here.
export function databaseClashes(
  servers: ClashServer[],
  targetOf: (oldServerId: string) => string | null | undefined,
  targetName: (serverId: string) => string,
): string[] {
  const groups = new Map<
    string,
    { host: string; to: string; dbs: string[]; from: string[] }
  >();
  for (const s of servers) {
    const to = targetOf(s.id);
    if (!to) continue;
    for (const d of s.databaseHosts ?? []) {
      const key = `${to}\u0000${d.host}`;
      const g = groups.get(key) ?? { host: d.host, to, dbs: [], from: [] };
      g.dbs.push(`${d.name} (on ${s.name})`);
      if (!g.from.includes(s.name)) g.from.push(s.name);
      groups.set(key, g);
    }
  }
  return [...groups.values()]
    .filter((g) => g.from.length > 1)
    .map(
      (g) =>
        `The databases ${listOf(g.dbs, "and")} ${g.dbs.length === 2 ? "both" : "all"} answer at ${g.host}, so they cannot share ${targetName(g.to)}: choose another server here for ${listOf(g.from, "or")}.`,
    );
}
