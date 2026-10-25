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

export function builtByDeplo(imageRef: string): boolean {
  return imageRef.startsWith("deplo/");
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

// What the badge counts and an alert may fire for: something the team can act on, or an attack.
export function isActionable(fix: FixKind, level: Level): boolean {
  if (level === "exploited") return true;
  return (
    fix === "code" ||
    fix === "rebuild" ||
    fix === "update" ||
    fix === "newer_tag"
  );
}

export function qualifiesForAlert(fix: FixKind, level: Level): boolean {
  return (
    level === "exploited" || (level === "critical" && isActionable(fix, level))
  );
}
