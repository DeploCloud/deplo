import { isReservedSharedName } from "./compose-lint/networks";
import { usesComposeStack } from "../utils";

// ADR-0028 amendment (#200): on a cluster, a member holds the names of its Environment's workloads that run
// on another member, and a NAME FORWARDER carries each connection there over the relay.

/** A single-image App on a cluster: its name is forwarded. A compose stack stays on one member and keeps its own names. */
export function isForwardedApp(
  app: Parameters<typeof usesComposeStack>[0] & { clusterId?: string | null },
  preview = false,
): boolean {
  return Boolean(app.clusterId) && !preview && !usesComposeStack(app);
}

export type ForwardedKind = "app" | "database";

export interface ForwardedWorkload {
  kind: ForwardedKind;
  id: string;
  /** The Environment's network (`deplo-env-<id>`), from the one network seam. */
  network: string;
  /** The public name: `db-<slug>`, or the App's name. Null for a compose stack, which reaches names and offers none. */
  name: string | null;
  /** The port the workload answers on (`portFor`, or the engine's). */
  port: number;
  /** Where each replica runs now, in placement order; the leader's mirror. */
  members: string[];
  /** Members holding a standby copy: they hold the name like any other, and may serve it once promoted. */
  standbys?: string[];
}

export interface HeldName {
  network: string;
  kind: ForwardedKind;
  workloadId: string;
  name: string;
  port: number;
}

export interface ServedName {
  network: string;
  kind: ForwardedKind;
  workloadId: string;
  port: number;
  /** Fingerprints of the OTHER members running a workload of the same Environment. */
  sourceFingerprints: string[];
}

export interface MemberForwarding {
  serverId: string;
  hold: HeldName[];
  serve: ServedName[];
  /** It runs, or stands by for, a workload with a name: a table it cannot take is a problem, not a detail. */
  involved: boolean;
}

/** What the server agent accepts in one table: names held, names served and the roster together. */
export const MAX_TABLE_ENTRIES = 512;

const byKey =
  <T>(key: (t: T) => string) =>
  (a: T, b: T) =>
    key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;

/**
 * Which names go on which member. Per network: a member running a workload of it holds the names of that
 * network's workloads placed elsewhere, and every member serves each name to the members that hold it.
 */
export function planNameForwarding(input: {
  workloads: ForwardedWorkload[];
  /** Certificate fingerprint of every member of the cluster; one with none is left out of the sources. */
  fingerprints: ReadonlyMap<string, string>;
}): Map<string, MemberForwarding> {
  const out = new Map<string, MemberForwarding>();
  const networks = new Map<string, ForwardedWorkload[]>();
  for (const w of input.workloads) {
    const list = networks.get(w.network) ?? [];
    list.push(w);
    networks.set(w.network, list);
  }
  const entry = (serverId: string): MemberForwarding => {
    let m = out.get(serverId);
    if (!m)
      out.set(
        serverId,
        (m = { serverId, hold: [], serve: [], involved: false }),
      );
    return m;
  };
  const cluster = [...input.fingerprints.keys()];
  for (const [network, group] of networks) {
    // The members running a workload of this Environment: the only ones that hold its names or dial for them.
    const running = [
      ...new Set(group.flatMap((w) => [...w.members, ...(w.standbys ?? [])])),
    ].sort();
    for (const serverId of [...new Set([...running, ...cluster])].sort()) {
      const m = entry(serverId);
      if (running.includes(serverId)) m.involved = true;
      const sources = running
        .filter((o) => o !== serverId)
        .map((o) => input.fingerprints.get(o))
        .filter((f): f is string => Boolean(f))
        .sort();
      for (const w of group) {
        // A name the proxy resolves on every network is never held, whatever a workload is called.
        if (w.name === null || isReservedSharedName(w.name)) continue;
        const base = { network, kind: w.kind, workloadId: w.id, port: w.port };
        // Served by every member ahead of time: wherever the leader starts it next, the others reach it before
        // Deplo has said a word. The server agent answers only while its lease places the workload on it.
        m.serve.push({ ...base, sourceFingerprints: sources });
        // Where it runs, its own container already answers to the name.
        if (running.includes(serverId) && !w.members.includes(serverId))
          m.hold.push({ ...base, name: w.name });
      }
    }
  }
  const runs = new Map(input.workloads.map((w) => [w.id, w] as const));
  for (const m of out.values()) {
    m.hold.sort(byKey((h) => `${h.network}|${h.name}`));
    m.serve.sort(byKey((s) => `${s.network}|${s.kind}|${s.workloadId}`));
    // ponytail: the server agent refuses a table over 512 entries, so past that only what a member runs or
    // stands by for is served ahead of time; raise both ends together when a cluster grows that large.
    const room = MAX_TABLE_ENTRIES - m.hold.length - input.fingerprints.size;
    if (m.serve.length <= room) continue;
    const here = (s: ServedName) => {
      const w = runs.get(s.workloadId);
      return Boolean(
        w?.members.includes(m.serverId) || w?.standbys?.includes(m.serverId),
      );
    };
    const ahead = m.serve.filter((s) => !here(s));
    const mine = m.serve.filter(here);
    m.serve = [...mine, ...ahead.slice(0, Math.max(room - mine.length, 0))];
    m.serve.sort(byKey((s) => `${s.network}|${s.kind}|${s.workloadId}`));
  }
  return out;
}
