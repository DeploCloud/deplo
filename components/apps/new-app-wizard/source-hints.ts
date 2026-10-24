import { SOURCE_TABS } from "@/components/apps/source-tabs";
import { archiveExt } from "@/lib/deploy/upload-shared";
import type { DeploySource } from "@/lib/types/app";

import type { WizardTemplate } from "./types";

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

export function nameFromImage(ref: string): string {
  const path = ref.trim().split("@")[0];
  const lastSegment = path.split("/").pop() ?? "";
  return lastSegment.split(":")[0] ?? "";
}

const ACRONYMS = new Set(
  "ai api aws cd cdn ci cli cms crm css csv db dns gcp html http https id json jwt llm mcp ml os pdf pwa qa rss s3 sdk seo smtp sql ssh ssl sso tls ui url ux vpn xml".split(
    " ",
  ),
);

// "owner/fenix-ui" -> "Fenix UI". Only separators turn into spaces, so the slug stays the repo's.
export function nameFromRepo(repo: string): string {
  return (repo.split("/").pop() ?? "")
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) =>
      ACRONYMS.has(w.toLowerCase())
        ? w.toUpperCase()
        : /[A-Z]/.test(w)
          ? w
          : w[0].toUpperCase() + w.slice(1),
    )
    .join(" ");
}

export function nameFromArchive(filename: string): string {
  const ext = archiveExt(filename);
  return ext ? filename.slice(0, -ext.length) : filename;
}

export function templateTitle(t: WizardTemplate): string {
  return t.variantName ? `${t.name} · ${t.variantName}` : t.name;
}

export function detailsDescription(source: DeploySource): string {
  return (
    SOURCE_TABS.find((t) => t.id === source)?.blurb ??
    "Where your code or image comes from."
  );
}
