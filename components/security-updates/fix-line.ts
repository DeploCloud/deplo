import type { FixKind } from "@/lib/security-updates/fix-kind";
import { plural } from "@/lib/utils";

export interface FixLineInput {
  fix: FixKind;
  ecosystem: string;
  packageName: string;
  installedVersion: string;
  fixedVersion: string | null;
  newerTag: string | null;
  // How many advisories an image's update closes.
  flaws: number;
  // Who pulls the package in, parent first; [] when direct or unknown.
  via: string[];
  // Named in the app's package.json; null when Deplo cannot tell.
  direct: boolean | null;
}

// A new major version, or a new minor on 0.x: an override there can break whoever pulls it in.
export function breakingBump(from: string, to: string | null): boolean {
  const parse = (v: string) => v.replace(/^v/, "").split(".").map(Number);
  if (!to) return false;
  const [a, b] = [parse(from), parse(to)];
  if (!Number.isInteger(a[0]) || !Number.isInteger(b[0])) return false;
  return a[0] !== b[0] || (a[0] === 0 && a[1] !== b[1]);
}

function codeLine(u: FixLineInput): string {
  const pkg = u.packageName;
  const breaking = breakingBump(u.installedVersion, u.fixedVersion);
  if (u.via.length)
    return breaking
      ? `Update ${u.via.at(-1)}: the fix for ${pkg} is a new major version, which an override could break`
      : `Pulled in by ${u.via.join(" ← ")}: add an override for ${pkg} ${u.fixedVersion}`;
  if (u.direct === false)
    return breaking
      ? `Pulled in by another package: the fix for ${pkg} is a new major version, so update the package that pulls it in`
      : `Pulled in by another package: add an override for ${pkg} ${u.fixedVersion}`;
  if (u.direct === null && u.ecosystem === "npm")
    return `Update ${pkg} to ${u.fixedVersion}, or add an override if another package pulls it in`;
  return `Update ${pkg} to ${u.fixedVersion} in your code`;
}

// What the team does to get the fix, in one line.
export function fixLine(u: FixLineInput): string {
  const flaws = plural(u.flaws, "known flaw", "known flaws");
  switch (u.fix) {
    case "code":
      return codeLine(u);
    case "build_only":
      return "Only used to build the app: it never runs";
    case "update":
      return `A newer build of this image fixes ${flaws}: update to get it`;
    case "newer_tag":
      return u.newerTag
        ? `Version ${u.newerTag} is available and fixes ${flaws}`
        : `A newer version of this image fixes ${flaws}`;
    case "upstream":
      return `The newer build still has ${u.flaws === 1 ? "it" : "them"}: waiting on the image's maintainers`;
    case "unverified":
      return `A newer build is out: Deplo is checking whether it fixes ${flaws}`;
    default:
      return "";
  }
}

// "EPSS 12%": the chance it is exploited in the next 30 days, as FIRST scores it.
export function epssLabel(epss: number | null): string | null {
  if (epss == null) return null;
  return epss < 0.01 ? "EPSS <1%" : `EPSS ${Math.round(epss * 100)}%`;
}

export const UNREADABLE: Record<string, string> = {
  too_large: "An image is too large to check on its server.",
  low_disk: "Its server is too low on disk space to check an image.",
  low_memory: "Its server is too low on memory to check an image.",
  timed_out: "Checking an image took too long.",
  unsupported: "Its server cannot check images yet.",
  failed: "An image could not be checked.",
};
