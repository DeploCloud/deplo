import type { CoolifyApplication } from "../client";

/** Which host each of Coolify's git source models lives on by default. */
const SOURCE_HOSTS: Record<string, string> = {
  githubapp: "https://github.com",
  gitlabapp: "https://gitlab.com",
  bitbucketapp: "https://bitbucket.org",
  giteaapp: "https://gitea.com",
};

/** The providers a Coolify source can name; `git` when the address stands alone. */
type GitOrigin = "git" | "github" | "gitlab" | "bitbucket" | "gitea";

/** And which provider each of them authenticates with once Deplo has a credential. */
const SOURCE_ORIGINS: Record<string, GitOrigin> = {
  githubapp: "github",
  gitlabapp: "gitlab",
  bitbucketapp: "bitbucket",
  giteaapp: "gitea",
};

/**
 * The clone URL for a Coolify application. `git_repository` is a whole URL for a
 * PUBLIC repo and a bare `owner/repo` behind a source, which `git clone` refuses
 * with "repository does not exist" - every git app a migration brought over.
 */
export function coolifyGitUrl(row: CoolifyApplication): {
  url: string | null;
  assumed: boolean;
  /** Which provider authenticates the clone. `git` when the address stands on its
   *  own: a public repository clones here anonymously, exactly as it did there. */
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
    // No host to read means the URL above assumed github.com: say so here too, or
    // the clone goes out anonymous against an address Deplo itself invented.
    origin: named ?? (host ? "git" : "github"),
  };
}
