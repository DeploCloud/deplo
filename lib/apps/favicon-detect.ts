import "server-only";

import { mkdtemp, rm, opendir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listRepoTree, fetchRepoBlob } from "../github/app";
import { extractArchive } from "../deploy/upload";
import { normalizeRootRel } from "../deploy/source";
import {
  pickBestFavicon,
  mimeForFaviconPath,
  scoreFaviconPath,
  isExcludedDirName,
  isGithubRepo,
  type FaviconFile,
} from "./favicon-shared";
import { isValidLogoValue, MAX_LOGO_BYTES } from "./logo-shared";
import type { GitRepo, UploadArchive } from "../types";

/**
 * Auto-detect an app's display logo from an icon/favicon shipped in its OWN
 * source files, returning a storable base64 data-URI (or null when none is
 * found). The pick + ranking is the pure {@link file://./favicon-shared.ts}
 * logic; this module is the server-only I/O around it — reading the file list
 * and the chosen icon's bytes — for each source kind:
 *
 *  - GitHub repos are cloned on the deploy AGENT, so the control plane never has
 *    the tree on disk; it reads the repo through the GitHub API (git tree +
 *    blob) instead — works for private (installation token) and public repos.
 *  - Uploaded archives live on the control plane, so we extract to a temp dir
 *    and scan the files (reusing extractArchive's symlink-reject guard).
 *
 * Every entry point is best-effort and non-throwing: detection is a cosmetic
 * nicety layered on deploy, never a reason to fail one.
 */

/** Turn chosen icon bytes into a validated `data:` logo URI, or null if the
 * bytes are empty / over the cap / an unsupported type. The final
 * `isValidLogoValue` gate is what every storer already trusts. */
function toLogoDataUri(bytes: Buffer, path: string): string | null {
  if (bytes.length === 0 || bytes.length > MAX_LOGO_BYTES) return null;
  const mime = mimeForFaviconPath(path);
  if (!mime) return null;
  const uri = `data:${mime};base64,${bytes.toString("base64")}`;
  return isValidLogoValue(uri) ? uri : null;
}

/** `owner/name` for a GitHub repo, taken from the stored `repo.repo` when it's
 * already `owner/name`, else parsed from a github.com URL. Null when the repo
 * isn't GitHub-hosted or can't be resolved to a clean owner/name. */
function githubFullName(repo: GitRepo): string | null {
  const OWNER_REPO = /^[\w.-]+\/[\w.-]+$/;
  if (repo.repo && OWNER_REPO.test(repo.repo)) return repo.repo.replace(/\.git$/, "");
  try {
    const u = new URL(repo.url ?? "");
    if (u.hostname.toLowerCase() !== "github.com") return null;
    const path = u.pathname.replace(/^\/+/, "").replace(/\.git$/, "");
    return OWNER_REPO.test(path) ? path : null;
  } catch {
    return null;
  }
}

/**
 * Detect an icon in a GitHub repo via the API. Works for a GitHub App import
 * (`source: "github"`, private repos use the installation token) AND a plain
 * github.com URL (`source: "git"`, read unauthenticated). `repo.branch` empty ⇒
 * the default branch ("HEAD"). `rootDirectory` biases the pick toward the
 * sub-app a monorepo builds from. Null for non-GitHub repos (GitLab / Bitbucket
 * / other git hosts have no tree-read path from the control plane).
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

// The extracted tree is fully attacker-controlled (an uploaded archive), so the
// walk is hard-bounded on every axis a crafted tree could blow up — never
// unbounded work regardless of how many dirs/files the archive packs:
//  - MAX_DIRS_WALKED   directories OPENED across the whole walk
//  - MAX_PENDING_DIRS  un-opened dirs held on the DFS stack (memory)
//  - MAX_ENTRIES_PER_DIR entries scanned within any ONE directory (a hostile
//    single mega-directory can't force an unbounded scan)
//  - MAX_CANDIDATES    icon candidates collected before we stop early
// Directories are STREAMED with opendir (not readdir), so a directory holding
// millions of entries is read incrementally instead of materialising every
// Dirent in memory at once.
const MAX_DIRS_WALKED = 4000;
const MAX_PENDING_DIRS = 8000;
const MAX_ENTRIES_PER_DIR = 50_000;
const MAX_CANDIDATES = 64; // far more than any real app ships; we only need the best

/** Collect icon-candidate files (relative path + size) from an extracted tree,
 * pruning dependency/build dirs during descent and never following symlinks.
 * Hard-bounded (see the caps above) so a hostile archive can't exhaust memory
 * or the event loop; only real icon-named candidates are stat'd/collected. */
async function collectTreeCandidates(root: string): Promise<FaviconFile[]> {
  const out: FaviconFile[] = [];
  const stack: string[] = [""]; // dirs relative to root; "" is the root itself
  let dirsWalked = 0;
  while (stack.length > 0 && dirsWalked < MAX_DIRS_WALKED && out.length < MAX_CANDIDATES) {
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
        // Only stat REAL icon candidates so `out` and the syscall count stay
        // small even for huge trees. The stat gives the true size so the byte
        // cap is applied by the ranker BEFORE we ever read a file — a
        // decompression-bombed `favicon.svg` is filtered out, never read into
        // memory. An unstatable entry is skipped.
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
 * Detect an icon in a stored upload archive: extract to a throwaway temp dir,
 * scan it, and clean up. The archive is fully attacker-controlled, so we lean
 * on extractArchive's symlink rejection + traversal guards + the bounded walk;
 * any extract failure just yields null (no icon). Used on demand by the manual
 * "Detect from source" action — the automatic upload path scans the tree the
 * DEPLOY already extracted (no second extraction), see the deploy engine.
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

/** The minimal app shape favicon detection reads. A loaded app graph
 * satisfies it structurally. */
export interface FaviconDetectApp {
  source: string;
  repo?: GitRepo | null;
  upload?: UploadArchive | null;
  build: { rootDirectory?: string | null };
}

/**
 * Detect a logo from whichever source an app builds from — the single entry
 * point the create hook, the upload route, and the manual "Detect from source"
 * action all share. Null when the source has no scannable files (a prebuilt
 * docker image, a non-GitHub git URL, or an upload with no archive yet).
 */
export async function detectAppFavicon(
  project: FaviconDetectApp,
): Promise<string | null> {
  // A repo source is keyed on the repo itself (provider/URL), NOT the `source`
  // string — a GitHub App import is `source: "github"`, a bare git URL is
  // `source: "git"`, and both carry a repo. isGithubRepo is the shared gate.
  if (project.repo && isGithubRepo(project.repo)) {
    return detectGithubFavicon(project.repo, project.build.rootDirectory ?? null);
  }
  if (project.source === "upload" && project.upload) {
    return detectUploadFavicon(project.upload, project.build.rootDirectory ?? null);
  }
  return null;
}
