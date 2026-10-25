import { isDistroEcosystem } from "./ecosystem";
import type { Severity } from "./osv";

export type Level = "exploited" | "critical" | "high";

// How the team gets the fix, judged from their side (see ADR-0038).
export type FixKind =
  "code" | "rebuild" | "update" | "newer_tag" | "deplo" | "none";

export function levelOf(
  severity: Severity | null,
  cve: string | null,
  kev: ReadonlySet<string>,
): Level | null {
  if (cve && kev.has(cve)) return "exploited";
  if (severity === "critical") return "critical";
  if (severity === "high") return "high";
  return null;
}

export interface FixInput {
  imageRef: string;
  // The app's build method for an image Deplo built ("railpack", "dockerfile", ...).
  builder: string | null;
  ecosystem: string;
  location: string;
  workingDir: string;
  fixedVersion: string | null;
  repoDigest: string;
  registryStatus: string | null;
  registryDigest: string | null;
  newerTag: string | null;
}

// `deplo/<key>:<deployment>`, or a compose `build:` service, named `deplo-<slug>-<service>`.
export function builtByDeplo(imageRef: string): boolean {
  return imageRef.startsWith("deplo/") || /^deplo-[a-z0-9._-]+$/.test(imageRef);
}

export function fixKind(i: FixInput): FixKind {
  if (!i.fixedVersion) return "none";
  if (builtByDeplo(i.imageRef)) {
    const railpack = i.builder === "railpack";
    if (!isDistroEcosystem(i.ecosystem) && underDir(i.location, i.workingDir))
      return "code";
    return railpack ? "deplo" : "rebuild";
  }
  // A private image still gets Update: whoever publishes it is on the team.
  if (i.registryStatus === "private") return "update";
  if (i.registryStatus !== "ok") return "none";
  if (i.repoDigest && i.registryDigest && i.registryDigest !== i.repoDigest)
    return "update";
  return i.newerTag ? "newer_tag" : "none";
}

function underDir(location: string, dir: string): boolean {
  const d = dir.replace(/\/+$/, "");
  return d !== "" && location.startsWith(`${d}/`);
}

export interface Scoped {
  fix: string;
  ecosystem: string;
  packageName: string;
  location: string;
}

// A binary another package carries, like esbuild's Go build inside node_modules.
function embedded(f: Scoped): boolean {
  const l = f.location;
  if (l.includes("/node_modules/")) return f.ecosystem !== "npm";
  if (l.includes("/site-packages/") || l.includes("/dist-packages/"))
    return f.ecosystem !== "PyPI";
  return false;
}

// Only what the app chose: its own dependencies, or the software an image ships (ADR-0038).
export function inScope(f: Scoped): boolean {
  if (embedded(f)) return false;
  if (f.fix === "code") return true;
  if (f.fix !== "update" && f.fix !== "newer_tag") return false;
  if (isDistroEcosystem(f.ecosystem)) return false;
  return !(f.ecosystem === "Go" && f.packageName === "stdlib");
}

// What the badge counts and an alert fires for; an Important one is listed only.
export function isActionable(f: Scoped & { level: string }): boolean {
  return inScope(f) && f.level !== "high";
}
