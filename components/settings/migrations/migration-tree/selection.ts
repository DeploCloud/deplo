import { isImportable, type Placement, type PlanService } from "../types";

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

export function shared<T>(values: (T | undefined)[]): T | undefined {
  if (values.length === 0) return undefined;
  const [first, ...rest] = values;
  return rest.every((v) => v === first) ? first : undefined;
}

export function tristate(on: number, total: number): boolean | "indeterminate" {
  if (total === 0 || on === 0) return false;
  return on === total ? true : "indeterminate";
}

export function countLabel(on: number, total: number): string {
  if (total === 0) return "Nothing to import";
  return `${on} of ${total} selected`;
}
