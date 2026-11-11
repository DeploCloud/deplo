// A replica is a compose container named `<project>-<service>-<n>`; the index is read from the name, never stored.

export interface ReplicaLabel {
  // What the person reads and logs are tagged with: `web-2`.
  label: string;
  // The service's own name without the index: `web`.
  base: string;
  index: number;
  // What the copies of one service share.
  service: string;
}

function split(container: string): { service: string; index: number } | null {
  const m = /^(.+)-(\d+)$/.exec(container);
  return m ? { service: m[1]!, index: Number(m[2]) } : null;
}

export function replicaIndexOf(container: string): number | null {
  return split(container)?.index ?? null;
}

// The service as the person named it: without Deplo's own prefixes.
function baseOf(service: string, slug: string): string {
  // The second is the stand-in a deploy runs beside the live copies.
  const project = [`deplo-${slug}-`, `deplo-${slug}_next-`].find((p) =>
    service.startsWith(p),
  );
  const own = project ? service.slice(project.length) : service;
  return own.replace(/^deplo-/, "") || slug;
}

// Labels only the containers that have siblings: one copy of a service is not a replica.
export function replicaLabels(
  containers: string[],
  slug: string,
): Map<string, ReplicaLabel> {
  const groups = new Map<string, { name: string; index: number }[]>();
  for (const name of containers) {
    const parts = split(name);
    if (!parts) continue;
    const list = groups.get(parts.service) ?? [];
    list.push({ name, index: parts.index });
    groups.set(parts.service, list);
  }
  const out = new Map<string, ReplicaLabel>();
  for (const [service, copies] of groups) {
    if (copies.length < 2) continue;
    const base = baseOf(service, slug);
    for (const { name, index } of copies)
      out.set(name, { label: `${base}-${index}`, base, index, service });
  }
  return out;
}

// The tag of a container known to be one of several copies (the App runs more than one replica).
export function replicaTag(container: string, slug: string): string {
  const parts = split(container);
  return parts ? `${baseOf(parts.service, slug)}-${parts.index}` : container;
}
