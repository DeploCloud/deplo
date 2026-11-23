// Which servers of a cluster reach each other without Deplo's relay (ADR-0047), and what a relayed pair costs.
// https://deplo.build/docs/operations/clusters/private-network#servers-that-need-the-relay

export type PairPath = "direct" | "relay" | "none";

/** One server's report of its path to another, as `cluster_network_links` keeps it. */
export interface PathReport {
  serverId: string;
  peerServerId: string;
  path: PairPath;
}

const key = (a: string, b: string) => (a < b ? `${a} ${b}` : `${b} ${a}`);

/** Each reported pair, and whether every report of it says direct. */
function pairs(reports: PathReport[]): Map<string, boolean> {
  const seen = new Map<string, boolean>();
  for (const r of reports) {
    const k = key(r.serverId, r.peerServerId);
    seen.set(k, (seen.get(k) ?? true) && r.path === "direct");
  }
  return seen;
}

/**
 * The most servers that all reach each other directly, in the given order; ties keep the earlier ones. A pair nobody
 * reported yet counts only with `unreported`. ponytail: exhaustive up to 16 servers, greedy past that.
 */
export function directCore(
  ids: string[],
  reports: PathReport[],
  unreported = false,
): string[] {
  const seen = pairs(reports);
  const linked = (a: string, b: string) => seen.get(key(a, b)) ?? unreported;
  if (ids.length > 16) {
    const core: string[] = [];
    for (const id of ids) if (core.every((c) => linked(c, id))) core.push(id);
    return core;
  }
  let best: string[] = ids.slice(0, 1);
  for (let mask = 1; mask < 1 << ids.length; mask++) {
    const pick = ids.filter((_, i) => mask & (1 << i));
    if (pick.length <= best.length) continue;
    if (pick.every((a, i) => pick.slice(i + 1).every((b) => linked(a, b))))
      best = pick;
  }
  return best;
}

export interface RelayLevel {
  /** 0: every pair direct; 1: some relayed, a direct majority stays; 2: no direct majority. */
  level: 0 | 1 | 2;
  /** The servers outside the core that reach some other only through the relay, as reported. */
  relayed: string[];
  core: string[];
}

/** How much of a cluster stops with Deplo's machine, from the paths its servers report. */
export function relayLevel(ids: string[], reports: PathReport[]): RelayLevel {
  // A server that just joined has no reports yet: it is not counted as relayed before it said so.
  const core = directCore(ids, reports, true);
  const seen = pairs(reports);
  const majority = core.length * 2 > ids.length;
  // Without a direct majority there is no side to be outside of: every server with a relayed pair is named.
  const relayed = ids.filter(
    (a) =>
      !(majority && core.includes(a)) &&
      ids.some((b) => b !== a && seen.get(key(a, b)) === false),
  );
  if (ids.length < 2 || relayed.length === 0)
    return { level: 0, relayed: [], core };
  return { level: majority ? 1 : 2, relayed, core };
}

/** The warning on a server that needs the relay to reach part of its cluster (its row and its page). */
export function relayedServerWarning(name: string): string {
  return `${name} reaches some servers of its cluster only through Deplo's relay. If Deplo's machine stops, ${name} stops as if its power were cut.`;
}

/** The cluster's own warning when no direct majority is left (level 2), on the cluster and in its Add dialog. */
export const NOT_FOR_PRODUCTION = {
  title: "Not OK for production",
  body: "Fewer than half of this cluster's servers reach each other directly: the rest only through Deplo's relay. If Deplo's machine stops, every App and database of this cluster stops. To fix it, give the servers a direct path to each other, or a second relay on another network.",
};
