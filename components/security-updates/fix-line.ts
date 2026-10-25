import type { FixKind } from "@/lib/security-updates/fix-kind";
import { plural } from "@/lib/utils";

export interface FixLineInput {
  fix: FixKind;
  packageName: string;
  fixedVersion: string | null;
  newerTag: string | null;
  // How many advisories an image's update closes.
  flaws: number;
}

// What the team does to get the fix, in one line.
export function fixLine(u: FixLineInput): string {
  const flaws = plural(u.flaws, "known flaw", "known flaws");
  switch (u.fix) {
    case "code":
      return `Update ${u.packageName} to ${u.fixedVersion} in your code`;
    case "update":
      return `A newer build of this image may fix ${flaws}: update to get it`;
    case "newer_tag":
      return u.newerTag
        ? `Version ${u.newerTag} is available and may fix ${flaws}`
        : `A newer version of this image may fix ${flaws}`;
    default:
      return "";
  }
}

export const UNREADABLE: Record<string, string> = {
  too_large: "An image is too large to check on its server.",
  low_disk: "Its server is too low on disk space to check an image.",
  low_memory: "Its server is too low on memory to check an image.",
  timed_out: "Checking an image took too long.",
  unsupported: "Its server cannot check images yet.",
  failed: "An image could not be checked.",
};
