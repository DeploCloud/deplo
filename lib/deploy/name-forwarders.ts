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
}

const byKey =
  <T>(key: (t: T) => string) =>
  (a: T, b: T) =>
    key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;

/**
 * Which names go on which member. Per network: a member running a workload of it holds the names of that
 * network's workloads placed elsewhere, and serves its own to the other members of that same network.
 */
export function planNameForwarding(input: {
  workloads: ForwardedWorkload[];
  /** Certificate fingerprint of each member server; one with none is left out of the sources. */
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
    if (!m) out.set(serverId, (m = { serverId, hold: [], serve: [] }));
    return m;
  };
  for (const [network, group] of networks) {
    const members = [
      ...new Set(group.flatMap((w) => [...w.members, ...(w.standbys ?? [])])),
    ].sort();
    for (const serverId of members) {
      const m = entry(serverId);
      const sources = members
        .filter((o) => o !== serverId)
        .map((o) => input.fingerprints.get(o))
        .filter((f): f is string => Boolean(f))
        .sort();
      for (const w of group) {
        // A name the proxy resolves on every network is never held, whatever a workload is called.
        if (w.name === null || isReservedSharedName(w.name)) continue;
        const base = { network, kind: w.kind, workloadId: w.id, port: w.port };
        // Where it runs, its own container already answers to the name.
        if (w.members.includes(serverId))
          m.serve.push({ ...base, sourceFingerprints: sources });
        else m.hold.push({ ...base, name: w.name });
        // Served ahead of time: after a promotion the others reach it before Deplo has said a word.
        if (!w.members.includes(serverId) && w.standbys?.includes(serverId))
          m.serve.push({ ...base, sourceFingerprints: sources });
      }
    }
  }
  for (const m of out.values()) {
    m.hold.sort(byKey((h) => `${h.network}|${h.name}`));
    m.serve.sort(byKey((s) => `${s.network}|${s.kind}|${s.workloadId}`));
  }
  return out;
}
