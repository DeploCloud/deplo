import type { FacetOption } from "@/components/env/env-filters/types";
import { TeamAvatar } from "@/components/shared/user-avatar";

export interface TeamRef {
  slug: string;
  name: string;
  avatarUrl?: string | null;
}

// One option per team that holds at least one row, counted by rows.
export function teamFacetOptions(rows: TeamRef[][]): {
  options: FacetOption[];
  counts: Record<string, number>;
} {
  const seen = new Map<string, TeamRef>();
  const counts: Record<string, number> = {};
  for (const teams of rows)
    for (const t of new Map(teams.map((x) => [x.slug, x])).values()) {
      seen.set(t.slug, t);
      counts[t.slug] = (counts[t.slug] ?? 0) + 1;
    }
  const options = [...seen.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((t) => ({
      value: t.slug,
      label: t.name,
      leading: <TeamAvatar name={t.name} avatarUrl={t.avatarUrl} size="xs" />,
    }));
  return { options, counts };
}

// An empty selection is no filter at all.
export function inAny(picked: string[], has: string[]): boolean {
  return picked.length === 0 || has.some((v) => picked.includes(v));
}

export function countBy<T>(
  rows: T[],
  key: (row: T) => string,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const r of rows) counts[key(r)] = (counts[key(r)] ?? 0) + 1;
  return counts;
}
