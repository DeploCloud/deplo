// One affected stretch of an advisory: from `introduced` up to `fixed` (or through `lastAffected`).
export interface AffectedRange {
  introduced: string;
  fixed: string | null;
  lastAffected: string | null;
}

const PRERELEASE = /^[-~]|^\.?(a|b|c|rc|alpha|beta|pre|preview|dev)/i;

// ponytail: token-wise, with semver/PEP 440 pre-releases first; not each ecosystem's full order.
export function compareVersions(a: string, b: string): number {
  const ta = a.replace(/^v/, "").match(/\d+|[^\d]+/g) ?? [];
  const tb = b.replace(/^v/, "").match(/\d+|[^\d]+/g) ?? [];
  for (let i = 0; i < Math.max(ta.length, tb.length); i++) {
    const x = ta[i];
    const y = tb[i];
    if (x === y) continue;
    // One ran out: "1.0.0" against "1.0.0-rc.1" is a release against its pre-release.
    if (x === undefined) return PRERELEASE.test(y!) ? 1 : -1;
    if (y === undefined) return PRERELEASE.test(x) ? -1 : 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) return Number(x) - Number(y);
    return x < y ? -1 : 1;
  }
  return 0;
}

// OSV range events, in order, as the stretches they describe.
export function rangesOf(events: Record<string, string>[]): AffectedRange[] {
  const out: AffectedRange[] = [];
  let open: AffectedRange | null = null;
  for (const e of events) {
    if (e.introduced !== undefined) {
      if (open) out.push(open);
      open = { introduced: e.introduced, fixed: null, lastAffected: null };
    } else if (
      open &&
      (e.fixed !== undefined || e.last_affected !== undefined)
    ) {
      open.fixed = e.fixed ?? null;
      open.lastAffected = e.last_affected ?? null;
      out.push(open);
      open = null;
    }
  }
  if (open) out.push(open);
  return out;
}

function holds(r: AffectedRange, v: string): boolean {
  if (r.introduced !== "0" && compareVersions(v, r.introduced) < 0)
    return false;
  if (r.fixed) return compareVersions(v, r.fixed) < 0;
  if (r.lastAffected) return compareVersions(v, r.lastAffected) <= 0;
  return true;
}

// Whether a version sits inside one of an advisory's affected stretches.
export function affects(ranges: AffectedRange[], version: string): boolean {
  return ranges.some((r) => holds(r, version));
}

// The fix on the installed version's own line, so 16.3.5 never gets 15.5.28's fix.
export function fixedFor(
  ranges: AffectedRange[],
  installed: string,
): string | null {
  const own = ranges.find((r) => holds(r, installed));
  if (own) return own.fixed;
  // Matched by a listed version rather than a range: the nearest fix above it.
  return (
    ranges
      .map((r) => r.fixed)
      .filter((f): f is string => !!f && compareVersions(f, installed) > 0)
      .sort(compareVersions)[0] ?? null
  );
}
