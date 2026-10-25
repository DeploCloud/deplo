import { isActionable, type FixKind, type Level } from "./fix-kind";

export interface Groupable {
  service: string;
  ecosystem: string;
  packageName: string;
  installedVersion: string;
  level: string;
  fix: string;
  fixedVersion?: string | null;
}

// One security update is one package to move: however many advisories that move closes.
export interface PackageGroup<T extends Groupable> {
  key: string;
  items: T[];
  level: Level;
  actionable: boolean;
  exploited: boolean;
  fix: FixKind;
  // The highest fixed version among the actionable advisories: the one that closes them all.
  fixedVersion: string | null;
}

const LEVEL_RANK: Record<Level, number> = {
  exploited: 0,
  critical: 1,
  high: 2,
};
const FIX_RANK: Record<FixKind, number> = {
  code: 0,
  rebuild: 1,
  update: 2,
  newer_tag: 3,
  deplo: 4,
  none: 5,
};

export const packageKey = (f: Groupable) =>
  `${f.service}\0${f.ecosystem}\0${f.packageName}\0${f.installedVersion}`;

// ponytail: token-wise compare, not each ecosystem's own order (dpkg epochs, PEP 440); fine for display.
export function compareVersions(a: string, b: string): number {
  const ta = a.match(/\d+|[^\d]+/g) ?? [];
  const tb = b.match(/\d+|[^\d]+/g) ?? [];
  for (let i = 0; i < Math.max(ta.length, tb.length); i++) {
    const x = ta[i] ?? "";
    const y = tb[i] ?? "";
    if (x === y) continue;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) return Number(x) - Number(y);
    return x < y ? -1 : 1;
  }
  return 0;
}

export function groupByPackage<T extends Groupable>(
  items: T[],
): PackageGroup<T>[] {
  const groups = new Map<string, T[]>();
  for (const f of items) {
    const k = packageKey(f);
    groups.set(k, [...(groups.get(k) ?? []), f]);
  }
  return [...groups].map(([key, list]) => {
    const live = list.filter((f) =>
      isActionable(f.fix as FixKind, f.level as Level),
    );
    const pick = live.length ? live : list;
    const fixed = pick
      .map((f) => f.fixedVersion)
      .filter((v): v is string => !!v)
      .sort(compareVersions)
      .at(-1);
    return {
      key,
      items: list,
      level: list
        .map((f) => f.level as Level)
        .sort((a, b) => LEVEL_RANK[a] - LEVEL_RANK[b])[0],
      actionable: live.length > 0,
      exploited: list.some((f) => f.level === "exploited"),
      fix: pick
        .map((f) => f.fix as FixKind)
        .sort((a, b) => FIX_RANK[a] - FIX_RANK[b])[0],
      fixedVersion: fixed ?? null,
    };
  });
}

export function countUpdates(items: Groupable[]): {
  count: number;
  exploited: number;
} {
  const live = groupByPackage(items).filter((g) => g.actionable);
  return {
    count: live.length,
    exploited: live.filter((g) => g.exploited).length,
  };
}
