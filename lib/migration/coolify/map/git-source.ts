import type { CoolifyApplication } from "../client";

const SOURCE_HOSTS: Record<string, string> = {
  githubapp: "https://github.com",
  gitlabapp: "https://gitlab.com",
  bitbucketapp: "https://bitbucket.org",
  giteaapp: "https://gitea.com",
};

type GitOrigin = "git" | "github" | "gitlab" | "bitbucket" | "gitea";

const SOURCE_ORIGINS: Record<string, GitOrigin> = {
  githubapp: "github",
  gitlabapp: "gitlab",
  bitbucketapp: "bitbucket",
  giteaapp: "gitea",
};

export function coolifyGitUrl(row: CoolifyApplication): {
  url: string | null;
  assumed: boolean;
  origin: GitOrigin;
} {
  const raw = row.git_repository?.trim() ?? "";
  const full = row.git_full_url?.trim() ?? "";
  const named =
    SOURCE_ORIGINS[
      (row.source_type ?? "").split("\\").pop()?.toLowerCase() ?? ""
    ];
  if (/^(https?|ssh|git):\/\//i.test(raw) || /^[^/]+@[^/]+:/.test(raw))
    return { url: raw, assumed: false, origin: "git" };
  if (full) return { url: full, assumed: false, origin: named ?? "git" };
  if (!raw) return { url: null, assumed: false, origin: "git" };

  const declared = row.source?.html_url?.trim();
  const kind = (row.source_type ?? "").split("\\").pop()?.toLowerCase() ?? "";
  const host = declared || SOURCE_HOSTS[kind];
  const path = raw.replace(/^\/+/, "").replace(/\.git$/i, "");
  return {
    url: `${(host ?? SOURCE_HOSTS.githubapp).replace(/\/+$/, "")}/${path}.git`,
    assumed: !host,
    origin: named ?? (host ? "git" : "github"),
  };
}
