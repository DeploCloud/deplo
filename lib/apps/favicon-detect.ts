import "server-only";

import { mkdtemp, rm, opendir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listRepoTree, fetchRepoBlob } from "../github/app";
import { githubFullName } from "../github/repo-id";
import { readGitCredential } from "../data/git-connections";
import { providerFor } from "../git/providers/registry";
import { extractArchive } from "../deploy/upload";
import { normalizeRootRel } from "../deploy/source";
import {
  pickBestFavicon,
  mimeForFaviconPath,
  scoreFaviconPath,
  isExcludedDirName,
  isGithubRepo,
  faviconSourceKind,
  type FaviconFile,
} from "./favicon-shared";
import {
  detectAgentFilesFavicon,
  detectServedFavicon,
  servedIconTarget,
  type IconProbeRoute,
  type ServedIconTarget,
} from "./favicon-agent";
import { isValidLogoValue, MAX_LOGO_BYTES } from "./logo-shared";
import type { UploadArchive } from "../types/app";
import type { GitRepo } from "../types/build";

function toLogoDataUri(
  bytes: Buffer,
  path: string,
  mime?: string,
): string | null {
  if (bytes.length === 0 || bytes.length > MAX_LOGO_BYTES) return null;
  const type = mime ?? mimeForFaviconPath(path);
  if (!type) return null;
  const uri = `data:${type};base64,${bytes.toString("base64")}`;
  return isValidLogoValue(uri) ? uri : null;
}

// detectGithubFavicon - an icon in a GitHub repo, via the API.
export async function detectGithubFavicon(
  repo: GitRepo,
  rootDirectory: string | null | undefined,
): Promise<string | null> {
  if (!isGithubRepo(repo)) return null;
  const fullName = githubFullName(repo);
  if (!fullName) return null;
  const tree = await listRepoTree(
    fullName,
    repo.branch?.trim() || "HEAD",
    repo.installationId ?? null,
  );
  if (tree.length === 0) return null;

  const best = pickBestFavicon(tree, {
    rootRel: normalizeRootRel(rootDirectory),
  });
  if (!best) return null;
  const entry = tree.find((e) => e.path === best.path);
  if (!entry) return null;

  const bytes = await fetchRepoBlob(
    fullName,
    entry.sha,
    repo.installationId ?? null,
  );
  if (!bytes) return null;
  return toLogoDataUri(bytes, best.path);
}

// detectConnectionFavicon - the same behind a git connection; its tree listing has no sizes, so the cap lands on the bytes.
export async function detectConnectionFavicon(
  repo: GitRepo,
  rootDirectory: string | null | undefined,
): Promise<string | null> {
  if (!repo.connectionId || !repo.repo) return null;
  const cred = await readGitCredential(repo.connectionId);
  const api = cred ? providerFor(cred.provider).api : null;
  if (!cred || !api) return null;
  const ref = repo.branch?.trim() || "HEAD";

  const paths = await api.listTree(cred, repo.repo, ref).catch(() => []);
  if (paths.length === 0) return null;

  const best = pickBestFavicon(
    paths.map((path) => ({ path, size: 0 })),
    { rootRel: normalizeRootRel(rootDirectory) },
  );
  if (!best) return null;

  const bytes = await api
    .readFileBytes(cred, repo.repo, ref, best.path)
    .catch(() => null);
  if (!bytes) return null;
  return toLogoDataUri(bytes, best.path);
}

// The extracted tree is attacker-controlled, so the walk is hard-bounded on every axis.
const MAX_DIRS_WALKED = 4000;
const MAX_PENDING_DIRS = 8000;
const MAX_ENTRIES_PER_DIR = 50_000;
const MAX_CANDIDATES = 64;

async function collectTreeCandidates(root: string): Promise<FaviconFile[]> {
  const out: FaviconFile[] = [];
  const stack: string[] = [""];
  let dirsWalked = 0;
  while (
    stack.length > 0 &&
    dirsWalked < MAX_DIRS_WALKED &&
    out.length < MAX_CANDIDATES
  ) {
    const rel = stack.pop()!;
    dirsWalked++;
    let dir;
    try {
      dir = await opendir(join(root, rel));
    } catch {
      continue;
    }
    // `for await` closes the handle on completion and on `break`, so an early bail leaks no fd.
    let seen = 0;
    for await (const e of dir) {
      if (out.length >= MAX_CANDIDATES || seen >= MAX_ENTRIES_PER_DIR) break;
      seen++;
      // extractArchive already rejects symlinks; this is belt-and-braces for any other tree.
      if (e.isSymbolicLink()) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!isExcludedDirName(e.name) && stack.length < MAX_PENDING_DIRS) {
          stack.push(childRel);
        }
      } else if (e.isFile()) {
        if (scoreFaviconPath(childRel) === null) continue;
        const size = await stat(join(root, childRel))
          .then((s) => s.size)
          .catch(() => -1);
        if (size >= 0) out.push({ path: childRel, size });
      }
    }
  }
  return out;
}

// detectTreeFavicon - an icon inside an already-extracted source tree on local disk.
export async function detectTreeFavicon(
  root: string,
  rootDirectory?: string | null,
): Promise<string | null> {
  const candidates = await collectTreeCandidates(root);
  // Candidates carry their real size, so pickBestFavicon already dropped any over the logo cap.
  const best = pickBestFavicon(candidates, {
    rootRel: normalizeRootRel(rootDirectory),
  });
  if (!best) return null;
  const bytes = await readFile(join(root, best.path)).catch(() => null);
  if (!bytes) return null;
  return toLogoDataUri(bytes, best.path);
}

// detectUploadFavicon - an icon in a stored upload archive, scanned in a throwaway temp dir.
export async function detectUploadFavicon(
  archive: UploadArchive,
  rootDirectory?: string | null,
): Promise<string | null> {
  let work: string | null = null;
  try {
    work = await mkdtemp(join(tmpdir(), "deplo-favicon-"));
    const root = await extractArchive(archive, work, () => {});
    return await detectTreeFavicon(root, rootDirectory);
  } catch {
    return null;
  } finally {
    if (work) await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

// detectAppFilesFavicon - an icon in an app's files dir on its owning server.
export async function detectAppFilesFavicon(
  serverId: string,
  slug: string,
): Promise<string | null> {
  const found = await detectAgentFilesFavicon(serverId, slug);
  return found ? toLogoDataUri(found.bytes, found.path) : null;
}

// detectServedAppFavicon - the icon a running compose app serves, asked for through its server's agent.
export async function detectServedAppFavicon(
  serverId: string,
  target: ServedIconTarget,
): Promise<string | null> {
  const found = await detectServedFavicon(serverId, target);
  return found ? toLogoDataUri(found.bytes, found.path, found.mime) : null;
}

// detectComposeAppFavicon - the whole compose arm: the app's own files first, then the icon it serves.
export async function detectComposeAppFavicon(
  serverId: string,
  slug: string,
  target: ServedIconTarget | null,
): Promise<string | null> {
  const fromFiles = await detectAppFilesFavicon(serverId, slug);
  if (fromFiles) return fromFiles;
  return target ? detectServedAppFavicon(serverId, target) : null;
}

// FaviconDetectApp - the minimal app shape favicon detection reads.
export interface FaviconDetectApp {
  id: string;
  slug: string;
  serverId: string;
  source: string;
  compose: string | null;
  dockerImage: string | null;
  repo?: GitRepo | null;
  upload?: UploadArchive | null;
  build: { rootDirectory?: string | null };
}

// appIconProbeTarget - where to reach a compose app's own web service, for the served-icon read.
export function appIconProbeTarget(
  app: FaviconDetectApp,
  routes: readonly IconProbeRoute[],
  primaryHost: string,
): ServedIconTarget | null {
  return servedIconTarget(
    { id: app.id, slug: app.slug, compose: app.compose },
    routes,
    primaryHost,
  );
}

// detectAppFavicon - a logo from whichever files an app actually owns, behind the settings "Detect from source" action.
export async function detectAppFavicon(
  project: FaviconDetectApp,
  routes: readonly IconProbeRoute[] = [],
  primaryHost = "",
): Promise<string | null> {
  switch (faviconSourceKind(project)) {
    case "app-files":
      return detectComposeAppFavicon(
        project.serverId,
        project.slug,
        appIconProbeTarget(project, routes, primaryHost),
      );
    // Keyed on the repo itself, not the `source` string: "github" and "git" both carry a repo.
    case "github":
      return project.repo
        ? detectGithubFavicon(project.repo, project.build.rootDirectory ?? null)
        : null;
    case "connection":
      return project.repo
        ? detectConnectionFavicon(
            project.repo,
            project.build.rootDirectory ?? null,
          )
        : null;
    case "upload":
      return project.upload
        ? detectUploadFavicon(
            project.upload,
            project.build.rootDirectory ?? null,
          )
        : null;
    default:
      return null;
  }
}
