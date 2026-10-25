import type { FixKind, Level } from "./fix-kind";

export interface Groupable {
  service: string;
  ecosystem: string;
  packageName: string;
  installedVersion: string;
  level: string;
  fix: string;
  fixedVersion?: string | null;
  // isActionable, decided where the whole finding is known.
  actionable: boolean;
}

// One security update is one thing to move: a package of the app's, or a whole image.
export interface UpdateGroup<T extends Groupable> {
  key: string;
  items: T[];
  level: Level;
  actionable: boolean;
  exploited: boolean;
  fix: FixKind;
  // An image's update moves the whole image; it has no single version.
  image: boolean;
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

const isImageFix = (fix: string) => fix === "update" || fix === "newer_tag";

export const unitKey = (
  f: Pick<
    Groupable,
    "service" | "ecosystem" | "packageName" | "installedVersion" | "fix"
  >,
) =>
  isImageFix(f.fix)
    ? `${f.service}\0image`
    : `${f.service}\0${f.ecosystem}\0${f.packageName}\0${f.installedVersion}`;

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

export function groupUpdates<T extends Groupable>(
  items: T[],
): UpdateGroup<T>[] {
  const groups = new Map<string, T[]>();
  for (const f of items) {
    const k = unitKey(f);
    groups.set(k, [...(groups.get(k) ?? []), f]);
  }
  return [...groups].map(([key, list]) => {
    const live = list.filter((f) => f.actionable);
    const pick = live.length ? live : list;
    const image = isImageFix(list[0].fix);
    const fixed = pick
      .map((f) => f.fixedVersion)
      .filter((v): v is string => !!v)
      .sort(compareVersions)
      .at(-1);
    return {
      key,
      items: list,
      level: pick
        .map((f) => f.level as Level)
        .sort((a, b) => LEVEL_RANK[a] - LEVEL_RANK[b])[0],
      actionable: live.length > 0,
      exploited: pick.some((f) => f.level === "exploited"),
      fix: pick
        .map((f) => f.fix as FixKind)
        .sort((a, b) => FIX_RANK[a] - FIX_RANK[b])[0],
      image,
      fixedVersion: image ? null : (fixed ?? null),
    };
  });
}

export function countUpdates(items: Groupable[]): {
  count: number;
  exploited: number;
} {
  const live = groupUpdates(items).filter((g) => g.actionable);
  return {
    count: live.length,
    exploited: live.filter((g) => g.exploited).length,
  };
}
