import type { ClusterWarning } from "./warnings";

export interface AddressedMember {
  name: string;
  v4: string[];
  v6: string[];
}

/**
 * One public address names one member: a router sends it to one machine only (ADR-0050).
 * Members come in the order they joined, and the first keeps the address.
 */
export function oneMemberPerAddress<M extends AddressedMember>(
  members: readonly M[],
): { members: M[]; shared: Map<string, string[]> } {
  const owner = new Map<string, string>();
  const shared = new Map<string, string[]>();
  const keep = (m: M, list: string[]) =>
    list.filter((a) => {
      const first = owner.get(a);
      if (first === undefined) {
        owner.set(a, m.name);
        return true;
      }
      shared.set(a, [...(shared.get(a) ?? [first]), m.name]);
      return false;
    });
  return {
    members: members.map((m) => ({
      ...m,
      v4: keep(m, m.v4),
      v6: keep(m, m.v6),
    })),
    shared,
  };
}

/** What the cluster's screen says about an address two members share. */
export function sharedAddressWarnings(
  shared: ReadonlyMap<string, readonly string[]>,
): ClusterWarning[] {
  return [...shared].map(([address, names]) => ({
    key: `shared-address:${address}`,
    title: "Two servers share one public address",
    body:
      `${names.join(" and ")} both use the public address ${address}. A router sends that address to one machine only, ` +
      `so the cluster names it once, for ${names[0]}, in its answers and its name servers.`,
  }));
}
