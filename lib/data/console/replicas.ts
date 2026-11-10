import { replicaIndexOf, replicaLabels } from "../../deploy/replica-names";
import type { ConsoleInstance } from "./index";

// The logs target that reads every copy of a service as one stream.
export const ALL_REPLICAS_PREFIX = "replicas:";

// Names each copy of a service that runs more than one (`web-1`); a lone container stays unnamed.
export function tagReplicas(
  instances: ConsoleInstance[],
  slug: string,
): ConsoleInstance[] {
  const labels = replicaLabels(
    instances.map((i) => i.name),
    slug,
  );
  return instances.map((i) => ({
    ...i,
    replica: labels.get(i.name)?.label ?? null,
  }));
}

export function byReplicaIndex(a: ConsoleInstance, b: ConsoleInstance): number {
  return (replicaIndexOf(a.name) ?? 0) - (replicaIndexOf(b.name) ?? 0);
}

// The copies of the service this instance is one of, when it has copies.
export function replicaGroupOf(
  instances: ConsoleInstance[],
  pick: ConsoleInstance,
): ConsoleInstance[] {
  if (!pick.replica) return [pick];
  return instances.filter((i) => i.replica && i.service === pick.service);
}

// The logs viewer lists "all replicas" ahead of a service's copies, and opens on it.
export function withReplicaGroups(
  instances: ConsoleInstance[],
  slug: string,
): ConsoleInstance[] {
  const labels = replicaLabels(
    instances.map((i) => i.name),
    slug,
  );
  const out: ConsoleInstance[] = [];
  const seen = new Set<string>();
  for (const i of instances) {
    const label = labels.get(i.name);
    if (label && !seen.has(label.service)) {
      seen.add(label.service);
      const copies = instances.filter((c) => c.service === i.service);
      out.push({
        ...i,
        name: `${ALL_REPLICAS_PREFIX}${i.service}`,
        replica: `${label.base} · all replicas`,
        running: copies.some((c) => c.running),
        state: copies.some((c) => c.running) ? "running" : i.state,
      });
    }
    out.push(i);
  }
  return out;
}
