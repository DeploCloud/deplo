import type { Deployment } from "../types/deployment";

// A deploy created after the last change applies it; one created before may have read the old config.
export function visiblePendingChanges(app: {
  pendingChangesAt?: string | null;
  latestDeployment?: Pick<Deployment, "status" | "createdAt"> | null;
}): string | null {
  const changed = app.pendingChangesAt ?? null;
  const dep = app.latestDeployment;
  if (!changed || !dep) return changed;
  const inFlight = dep.status === "queued" || dep.status === "building";
  return inFlight && Date.parse(dep.createdAt) >= Date.parse(changed)
    ? null
    : changed;
}
