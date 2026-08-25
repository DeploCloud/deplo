import "server-only";

import { mkdtemp, rm, opendir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listRepoTree, fetchRepoBlob } from "../github/app";
import { githubFullName } from "../github/repo-id";
import { readGitCredential } from "../data/git-connections";
import { providerFor } from "../git/providers";
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
import type { GitRepo, UploadArchive } from "../types";

/**
 * Auto-detect an app's display logo from an icon/favicon shipped in its OWN source
 * files, returning a storable base64 data-URI (or null when none is found).
 */

/**
 * Turn chosen icon bytes into a validated `data:` logo URI, or null if the bytes
 * are empty / over the cap / an unsupported type. The final `isValidLogoValue`
 * gate is what every storer already trusts.
 */
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

/**
 * Detect an icon in a GitHub repo via the API.
 */
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

/**
 * The same, for a repo behind a git connection. The provider's tree listing has
 * no per-entry size, so every candidate goes in with size 0 - `pickBestFavicon`
 * keeps an unknown size and the cap is enforced on the bytes instead.
 */
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

// The extracted tree is fully attacker-controlled (an uploaded archive), so the
// walk is hard-bounded on every axis a crafted tree could blow up — never unbounded
// work regardless of how many dirs/files the archive packs: - MAX_DIRS_WALKED
const MAX_DIRS_WALKED = 4000;
const MAX_PENDING_DIRS = 8000;
const MAX_ENTRIES_PER_DIR = 50_000;
const MAX_CANDIDATES = 64; // far more than any real app ships; we only need the best

/**
 * Collect icon-candidate files (relative path + size) from an extracted tree,
 * pruning dependency/build dirs during descent and never following symlinks.
 */
async function collectTreeCandidates(root: string): Promise<FaviconFile[]> {
  const out: FaviconFile[] = [];
  const stack: string[] = [""]; // dirs relative to root; "" is the root itself
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
    // `for await` streams entries and auto-closes the handle on completion AND
    // on `break`, so the caps below can bail early without leaking a fd.
    let seen = 0;
    for await (const e of dir) {
      if (out.length >= MAX_CANDIDATES || seen >= MAX_ENTRIES_PER_DIR) break;
      seen++;
      // A symlink is neither a dir nor a file here, so it is ignored
      // (extractArchive already rejects archives containing symlinks; this is
      // belt-and-braces for any other tree we might scan).
      if (e.isSymbolicLink()) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        // Prune dependency/build/VCS dirs (never a project's own icon) so the
        // bounded dir budget is spent on real source, not node_modules — and cap
        // the pending stack so a fan-out of a million subdirs can't grow it.
        if (!isExcludedDirName(e.name) && stack.length < MAX_PENDING_DIRS) {
          stack.push(childRel);
        }
      } else if (e.isFile()) {
        // Only stat REAL icon candidates so `out` and the syscall count stay small even for
        // huge trees.
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

/**
 * Detect an icon inside an already-extracted source tree on local disk.
 * `rootDirectory` (the build sub-path) biases the pick toward the sub-app the
 * app actually builds from — same disambiguation the GitHub arm applies.
 */
export async function detectTreeFavicon(
  root: string,
  rootDirectory?: string | null,
): Promise<string | null> {
  const candidates = await collectTreeCandidates(root);
  // Candidates carry their real size (stat'd above), so pickBestFavicon already
  // dropped any over the logo cap — we only ever read a within-cap file here.
  const best = pickBestFavicon(candidates, {
    rootRel: normalizeRootRel(rootDirectory),
  });
  if (!best) return null;
  const bytes = await readFile(join(root, best.path)).catch(() => null);
  if (!bytes) return null;
  return toLogoDataUri(bytes, best.path);
}

/**
 * Detect an icon in a stored upload archive: extract to a throwaway temp dir, scan
 * it, and clean up.
 */
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

/**
 * Detect an icon in an app's files dir on its OWNING SERVER — the compose-stack
 * arm, where "the app's own files" is the `<stacks>/files/<slug>` tree its `./x`
 * bind mounts resolve into.
 */
export async function detectAppFilesFavicon(
  serverId: string,
  slug: string,
): Promise<string | null> {
  const found = await detectAgentFilesFavicon(serverId, slug);
  return found ? toLogoDataUri(found.bytes, found.path) : null;
}

/**
 * Detect the icon a RUNNING compose app serves, by asking the app for it through
 * its owning server's agent.
 */
export async function detectServedAppFavicon(
  serverId: string,
  target: ServedIconTarget,
): Promise<string | null> {
  const found = await detectServedFavicon(serverId, target);
  return found ? toLogoDataUri(found.bytes, found.path, found.mime) : null;
}

/**
 * The whole compose-stack arm: the app's own files first, then the icon it serves.
 */
export async function detectComposeAppFavicon(
  serverId: string,
  slug: string,
  target: ServedIconTarget | null,
): Promise<string | null> {
  const fromFiles = await detectAppFilesFavicon(serverId, slug);
  if (fromFiles) return fromFiles;
  return target ? detectServedAppFavicon(serverId, target) : null;
}

/** The minimal app shape favicon detection reads. A loaded app graph
 * satisfies it structurally. */
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

/**
 * Where to reach a compose app's own web service, for the served-icon read.
 * Split out so a caller that already has the app's routes (a deploy) hands them
 * straight over, while one that doesn't (the settings action) can load them.
 */
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

/**
 * Detect a logo from whichever files an app actually owns — the on-demand entry
 * point behind the settings "Detect from source" action (the deploy hooks call the
 * arm their source already resolved). gate and this dispatch can never disagree.
 */
export async function detectAppFavicon(
  project: FaviconDetectApp,
  routes: readonly IconProbeRoute[] = [],
  primaryHost = "",
): Promise<string | null> {
  switch (faviconSourceKind(project)) {
    // A compose stack's icon lives on its host: in the files it mounts, or
    // inside the images it runs (where only the running app can show it).
    case "app-files":
      return detectComposeAppFavicon(
        project.serverId,
        project.slug,
        appIconProbeTarget(project, routes, primaryHost),
      );
    // A repo source is keyed on the repo itself (provider/URL), NOT the `source`
    // string — a GitHub App import is `source: "github"`, a bare git URL is
    // `source: "git"`, and both carry a repo.
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
