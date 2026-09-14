import { isImportable, type Placement, type PlanService } from "../types";

// tickAll ticks or unticks a whole branch in one write.
export function tickAll(
  chosen: Set<string>,
  services: PlanService[],
  on: boolean,
): Set<string> {
  const next = new Set(chosen);
  for (const s of services) {
    if (!isImportable(s)) continue;
    if (on) next.add(s.sourceId);
    else next.delete(s.sourceId);
  }
  return next;
}

// placeAll merges one patch into the placement of every service id it already holds.
export function placeAll(
  placements: Record<string, Placement>,
  serviceIds: string[],
  patch: Partial<Placement>,
): Record<string, Placement> {
  const next = { ...placements };
  for (const id of serviceIds) {
    const current = next[id];
    if (!current) continue;
    next[id] = { ...current, ...patch };
  }
  return next;
}

// shared is the one value every entry holds, or undefined when they disagree.
export function shared<T>(values: (T | undefined)[]): T | undefined {
  if (values.length === 0) return undefined;
  const [first, ...rest] = values;
  return rest.every((v) => v === first) ? first : undefined;
}

// tristate reads a branch's tick from how many of its leaves are on.
export function tristate(on: number, total: number): boolean | "indeterminate" {
  if (total === 0 || on === 0) return false;
  return on === total ? true : "indeterminate";
}

// countLabel is a selection counter, not a size.
export function countLabel(on: number, total: number): string {
  if (total === 0) return "Nothing to import";
  return `${on} of ${total} selected`;
}
