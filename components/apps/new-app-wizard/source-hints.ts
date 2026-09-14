import { SOURCE_TABS } from "@/components/apps/source-tabs";
import { archiveExt } from "@/lib/deploy/upload-shared";
import type { DeploySource } from "@/lib/types/app";

import type { WizardTemplate } from "./types";

// parseRepo - the owner/repo and the host a pasted Git address points at, or null.
export function parseRepo(url: string): {
  repo: string;
  provider: "github" | "gitlab" | "bitbucket" | "git";
} | null {
  const clean = url.trim().replace(/\.git$/, "");
  const m = clean.match(
    /(?:github|gitlab|bitbucket)\.com[/:]([\w.-]+\/[\w.-]+)/i,
  );
  const provider = /gitlab/i.test(clean)
    ? "gitlab"
    : /bitbucket/i.test(clean)
      ? "bitbucket"
      : /github/i.test(clean)
        ? "github"
        : "git";
  if (m) return { repo: m[1], provider };
  if (/^[\w.-]+\/[\w.-]+$/.test(clean))
    return { repo: clean, provider: "github" };
  if (/^https?:\/\/.+\/.+/.test(clean)) {
    const tail = clean.replace(/^https?:\/\/[^/]+\//, "");
    return { repo: tail, provider: "git" };
  }
  return null;
}

/** The app name an image reference suggests: `ghcr.io/acme/api:v2` ⇒ `api`. */
export function nameFromImage(ref: string): string {
  const path = ref.trim().split("@")[0];
  const lastSegment = path.split("/").pop() ?? "";
  return lastSegment.split(":")[0] ?? "";
}

/** The app name an archive suggests: `shop.tar.gz` ⇒ `shop`. */
export function nameFromArchive(filename: string): string {
  const ext = archiveExt(filename);
  return ext ? filename.slice(0, -ext.length) : filename;
}

// templateTitle - the card's heading for a template, variant included.
export function templateTitle(t: WizardTemplate): string {
  return t.variantName ? `${t.name} · ${t.variantName}` : t.name;
}

// detailsDescription - the blurb the picked source puts under the card title.
export function detailsDescription(source: DeploySource): string {
  return (
    SOURCE_TABS.find((t) => t.id === source)?.blurb ??
    "Where your code or image comes from."
  );
}
