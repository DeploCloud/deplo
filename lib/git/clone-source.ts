// https://deplo.build/docs/guides/deploy/deploy-button
export type CloneHost = "github" | "gitlab";

export interface CloneSource {
  host: CloneHost;
  // owner/repo on GitHub, group/(subgroup/)project on GitLab.
  fullName: string;
  // null = the repository's default branch, resolved when the files are read.
  ref: string | null;
  // A compose file the deploy builds with, relative to the repository root.
  composeFile: string | null;
  url: string;
}

const SEGMENT = /^[\w.~-]+$/;

const HOST_LABELS: Record<CloneHost, string> = {
  github: "GitHub",
  gitlab: "GitLab",
};

export function cloneHostLabel(host: CloneHost): string {
  return HOST_LABELS[host];
}

function cleanSegments(parts: string[]): string[] | null {
  const out = parts.map((p) => decodeURIComponent(p));
  return out.every((p) => SEGMENT.test(p) && p !== "." && p !== "..")
    ? out
    : null;
}

function safePath(parts: string[]): string | null {
  const clean = cleanSegments(parts);
  return clean && clean.length > 0 ? clean.join("/") : null;
}

function parseUrl(input: string): URL | null {
  const raw = input.trim();
  if (!raw) return null;
  try {
    const url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

function fromGithub(url: URL): CloneSource | null {
  const parts = url.pathname.split("/").filter(Boolean);
  if (url.hostname === "raw.githubusercontent.com") {
    // /<owner>/<repo>/<ref>/<path...>; a ref with a slash is read as its first segment.
    const [owner, repo, ref, ...file] = parts;
    const names = cleanSegments([owner ?? "", repo ?? "", ref ?? ""]);
    const path = safePath(file);
    if (!names || !path) return null;
    return github(names[0], names[1], names[2], path);
  }
  const [owner, rawRepo, kind, ref, ...rest] = parts;
  const repo = rawRepo?.replace(/\.git$/, "");
  const names = cleanSegments([owner ?? "", repo ?? ""]);
  if (!names) return null;
  if (!kind) return github(names[0], names[1], null, null);
  const refName = ref ? cleanSegments([ref])?.[0] : null;
  if (!refName) return null;
  if (kind === "tree") return github(names[0], names[1], refName, null);
  if (kind === "blob" || kind === "raw") {
    const path = safePath(rest);
    return path ? github(names[0], names[1], refName, path) : null;
  }
  return null;
}

function github(
  owner: string,
  repo: string,
  ref: string | null,
  composeFile: string | null,
): CloneSource {
  return {
    host: "github",
    fullName: `${owner}/${repo}`,
    ref,
    composeFile,
    url: `https://github.com/${owner}/${repo}`,
  };
}

function fromGitlab(url: URL): CloneSource | null {
  const parts = url.pathname.split("/").filter(Boolean);
  const dash = parts.indexOf("-");
  const project = (dash === -1 ? parts : parts.slice(0, dash)).map((p, i, a) =>
    i === a.length - 1 ? p.replace(/\.git$/, "") : p,
  );
  const names = cleanSegments(project);
  if (!names || names.length < 2) return null;
  const fullName = names.join("/");
  const base = {
    host: "gitlab" as const,
    fullName,
    url: `https://gitlab.com/${fullName}`,
  };
  if (dash === -1) return { ...base, ref: null, composeFile: null };
  const [kind, ref, ...rest] = parts.slice(dash + 1);
  const refName = ref ? cleanSegments([ref])?.[0] : null;
  if (!refName) return null;
  if (kind === "tree") return { ...base, ref: refName, composeFile: null };
  if (kind === "blob" || kind === "raw") {
    const path = safePath(rest);
    return path ? { ...base, ref: refName, composeFile: path } : null;
  }
  return null;
}

// A deploy button's repo= and/or compose= link, as the repository it names. compose= alone names one too.
export function parseCloneSource(input: {
  repo?: string | null;
  compose?: string | null;
}): CloneSource | null {
  const fromCompose = input.compose ? parseOne(input.compose) : null;
  if (input.compose && !fromCompose?.composeFile) return null;
  if (!input.repo) return fromCompose;
  const fromRepo = parseOne(input.repo);
  if (!fromRepo) return null;
  if (!fromCompose) return fromRepo;
  if (
    fromCompose.host !== fromRepo.host ||
    fromCompose.fullName.toLowerCase() !== fromRepo.fullName.toLowerCase()
  )
    return null;
  return {
    ...fromRepo,
    ref: fromRepo.ref ?? fromCompose.ref,
    composeFile: fromCompose.composeFile,
  };
}

function parseOne(input: string): CloneSource | null {
  const url = parseUrl(input);
  if (!url) return null;
  const host = url.hostname.toLowerCase();
  if (
    host === "github.com" ||
    host === "www.github.com" ||
    host === "raw.githubusercontent.com"
  )
    return fromGithub(url);
  if (host === "gitlab.com" || host === "www.gitlab.com")
    return fromGitlab(url);
  return null;
}

// A repository name every provider accepts: letters, digits, dot, dash and underscore.
export function suggestedRepoName(
  source: Pick<CloneSource, "fullName">,
): string {
  return cleanRepoName(source.fullName.split("/").at(-1) ?? "");
}

export function cleanRepoName(name: string): string {
  return name
    .trim()
    .replace(/[^\w.-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 100);
}

export function repoNameProblem(name: string): string | null {
  if (!name.trim()) return "Enter a repository name";
  if (name !== cleanRepoName(name))
    return "Use letters, digits, dots, dashes and underscores only";
  if (/\.git$/i.test(name)) return "A repository name can't end in .git";
  return null;
}
