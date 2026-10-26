import { isDistroEcosystem } from "./ecosystem";
import type { Severity } from "./osv";

export type Level = "exploited" | "critical" | "high";

// How the team gets the fix, judged from their side (see ADR-0038).
export type FixKind =
  | "code"
  | "rebuild"
  | "update"
  | "newer_tag"
  // A newer build or tag exists but still has it, or was not read yet: listed, never counted.
  | "upstream"
  | "unverified"
  // Reachable only from the app's devDependencies: listed under Build only, never counted.
  | "build_only"
  | "deplo"
  | "none";

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
  // What the newer build or tag holds for this package, once Deplo has read it.
  candidate: "fixed" | "vulnerable" | "unread";
  buildOnly: boolean;
  // A managed database runs its engine; the language packages beside it belong to bundled tools.
  database?: boolean;
}

// `deplo/<key>:<deployment>`, or a compose `build:` service, named `deplo-<slug>-<service>`.
export function builtByDeplo(imageRef: string): boolean {
  return imageRef.startsWith("deplo/") || /^deplo-[a-z0-9._-]+$/.test(imageRef);
}

export function fixKind(i: FixInput): FixKind {
  if (!i.fixedVersion) return "none";
  if (i.database && !isDistroEcosystem(i.ecosystem)) return "none";
  // A vendor's dev tools are not the team's to change.
  if (i.buildOnly) return builtByDeplo(i.imageRef) ? "build_only" : "none";
  if (builtByDeplo(i.imageRef)) {
    const railpack = i.builder === "railpack";
    if (
      !isDistroEcosystem(i.ecosystem) &&
      (underDir(i.location, i.workingDir) ||
        appInstallRoot(i.ecosystem, i.location))
    )
      return "code";
    return railpack ? "deplo" : "rebuild";
  }
  // A private image still gets Update: whoever publishes it is on the team.
  if (i.registryStatus === "private") return "update";
  if (i.registryStatus !== "ok") return "none";
  const newer =
    i.repoDigest && i.registryDigest && i.registryDigest !== i.repoDigest
      ? "update"
      : i.newerTag
        ? "newer_tag"
        : null;
  if (!newer) return "none";
  // Update is offered only when the newer build was read and has the fix.
  if (i.candidate === "fixed") return newer;
  return i.candidate === "vulnerable" ? "upstream" : "unverified";
}

const IMAGE_FIXES = new Set(["update", "newer_tag", "upstream", "unverified"]);

function underDir(location: string, dir: string): boolean {
  const d = dir.replace(/\/+$/, "");
  return d !== "" && location.startsWith(`${d}/`);
}

// Where a build installs the app's own packages outside its folder: Bundler's gems, a Dockerfile's pip.
function appInstallRoot(ecosystem: string, location: string): boolean {
  if (ecosystem === "RubyGems")
    return location.startsWith("/usr/local/bundle/");
  if (ecosystem === "PyPI")
    return /^\/usr\/local\/lib\/python3[.\d]*\/(site|dist)-packages\//.test(
      location,
    );
  return false;
}

export interface Scoped {
  fix: string;
  ecosystem: string;
  packageName: string;
  location: string;
}

// A binary another package carries, like esbuild's Go build inside node_modules, or a tool's own copy.
function embedded(f: Scoped): boolean {
  const l = f.location;
  if (l.includes("/_vendor/")) return true;
  if (/\/lib\/node_modules\/(npm|corepack)\//.test(l)) return true;
  if (l.includes("/node_modules/")) return f.ecosystem !== "npm";
  if (l.includes("/site-packages/") || l.includes("/dist-packages/"))
    return f.ecosystem !== "PyPI";
  return false;
}

// The language toolchain itself, never a dependency the app chose.
function toolchain(f: Scoped): boolean {
  if (f.ecosystem === "Go") return f.packageName === "stdlib";
  return (
    f.ecosystem === "PyPI" &&
    ["pip", "setuptools", "wheel"].includes(f.packageName)
  );
}

// Only what the app chose: its own dependencies, or the software an image ships (ADR-0038).
export function inScope(f: Scoped): boolean {
  if (embedded(f) || toolchain(f)) return false;
  if (f.fix === "code" || f.fix === "build_only") return true;
  if (!IMAGE_FIXES.has(f.fix)) return false;
  return !isDistroEcosystem(f.ecosystem);
}

// What the badge counts and an alert fires for; an Important one is listed only.
export function isActionable(f: Scoped & { level: string }): boolean {
  const applicable =
    f.fix === "code" || f.fix === "update" || f.fix === "newer_tag";
  return applicable && inScope(f) && f.level !== "high";
}
