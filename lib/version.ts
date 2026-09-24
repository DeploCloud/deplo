import { version as packageVersion } from "../package.json";

export const DEPLO_VERSION: string = packageVersion;
export const DEPLO_REPO = "DeploCloud/deplo";

export const FALLBACK_AGENT_VERSION = "0.3.0";

type Semver = { core: [number, number, number]; pre: string[] };

function parseSemver(v: string): Semver | null {
  const m = v
    .trim()
    .replace(/^v/i, "")
    .match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!m) return null;
  // `git describe` (0.2.0-8-gb39f8a7) is a build AFTER the tag, not a canary of it.
  const pre = m[4] && !/^\d+-g[0-9a-f]{4,}(-dirty)?$/.test(m[4]) ? m[4] : "";
  return {
    core: [Number(m[1]), Number(m[2]), Number(m[3])],
    pre: pre ? pre.split(".") : [],
  };
}

// Semver precedence: 1.2.0-canary.1 < 1.2.0-canary.2 < 1.2.0.
function comparePre(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return b.length - a.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === undefined) return -1;
    if (b[i] === undefined) return 1;
    const na = /^\d+$/.test(a[i]) ? Number(a[i]) : NaN;
    const nb = /^\d+$/.test(b[i]) ? Number(b[i]) : NaN;
    if (!Number.isNaN(na) && !Number.isNaN(nb)) {
      if (na !== nb) return na - nb;
    } else if (!Number.isNaN(na)) return -1;
    else if (!Number.isNaN(nb)) return 1;
    else if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

export function isNewer(latest: string, current: string): boolean {
  const a = parseSemver(latest);
  const b = parseSemver(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a.core[i] > b.core[i]) return true;
    if (a.core[i] < b.core[i]) return false;
  }
  return comparePre(a.pre, b.pre) > 0;
}

/** A canary (pre-release) version: anything after a `-`, e.g. 0.3.0-canary.1. */
export function isPrerelease(v: string): boolean {
  return (parseSemver(v)?.pre.length ?? 0) > 0;
}

/** The newest of `items` by semver, ignoring anything that is not one. */
export function newestVersion<T>(
  items: T[],
  version: (item: T) => string,
): T | null {
  let best: T | null = null;
  for (const item of items) {
    if (!parseSemver(version(item))) continue;
    if (!best || isNewer(version(item), version(best))) best = item;
  }
  return best;
}

export function agentUpdateAvailable(
  reported: string | null,
  expected: string,
): boolean {
  if (!reported || !parseSemver(reported) || !parseSemver(expected))
    return true;
  return isNewer(expected, reported);
}

export function reportedAgentVersion(server: {
  agent?: { version: string };
}): string | null {
  return server.agent?.version || null;
}
