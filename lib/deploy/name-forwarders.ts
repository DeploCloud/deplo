import { usesComposeStack } from "../utils";

// https://deplo.build/docs/guides/clusters (#200, ADR-0028 amendment)
// On a cluster a workload keeps its public name wherever it runs: a NAME FORWARDER on each member holds
// the name on the Environment's network and the workload's own container answers under its origin name.

/** `.` never ends a slug, so no other workload's name can equal an origin name. */
export function originName(name: string): string {
  return `${name}.origin`;
}

/** A single-image App on a cluster; a compose stack is one workload on one member and keeps its own names. */
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
  /** The public name: `db-<slug>`, or the App's name. */
  name: string;
  /** The port the workload answers on (`portFor`, or the engine's). */
  port: number;
  /** Where each replica runs now, in placement order; the leader's mirror. */
  members: string[];
}

export interface HeldName {
  network: string;
  kind: ForwardedKind;
  workloadId: string;
  name: string;
  port: number;
  origin: string;
}

export interface ServedName {
  network: string;
  kind: ForwardedKind;
  workloadId: string;
  port: number;
  origin: string;
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
 * Which names go on which member. Per network: every member running a workload of it holds every name of it
 * (no other network's), and serves the workloads placed on it to the other members of that same network.
 * A workload waiting for room has no member and so no entry of its own.
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
    const members = [...new Set(group.flatMap((w) => w.members))].sort();
    for (const serverId of members) {
      const m = entry(serverId);
      const sources = members
        .filter((o) => o !== serverId)
        .map((o) => input.fingerprints.get(o))
        .filter((f): f is string => Boolean(f))
        .sort();
      for (const w of group) {
        m.hold.push({
          network,
          kind: w.kind,
          workloadId: w.id,
          name: w.name,
          port: w.port,
          origin: originName(w.name),
        });
        if (w.members.includes(serverId))
          m.serve.push({
            network,
            kind: w.kind,
            workloadId: w.id,
            port: w.port,
            origin: originName(w.name),
            sourceFingerprints: sources,
          });
      }
    }
  }
  for (const m of out.values()) {
    m.hold.sort(byKey((h) => `${h.network}|${h.name}`));
    m.serve.sort(byKey((s) => `${s.network}|${s.kind}|${s.workloadId}`));
  }
  return out;
}
