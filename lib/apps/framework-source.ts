import "server-only";

import { opendir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { listRepoTree, fetchRepoBlob } from "../github/app";
import { githubFullName } from "../github/repo-id";
import { readGitCredential } from "../data/git-connections";
import { providerFor, readProviderText } from "../git/providers";
import { normalizeRootRel, resolveBuildDir } from "../deploy/source";
import { isGithubRepo } from "./favicon-shared";
import { supportsFrameworkDetection, type FrameworkId } from "./framework-catalog";
import {
  detectFramework,
  parsePackageManifest,
  rootFileNames,
  type PackageManifest,
} from "./framework-detect";
import type { BuildConfig, GitRepo } from "../types";

/**
 * Reading an app's own source to name its framework — the server-only I/O around
 * the pure rules in {@link file://./framework-detect.ts}, one arm per source
 * kind, mirroring how favicon detection is split:
 *
 *  - a GitHub repo is cloned on the deploy AGENT, so the control plane never has
 *    the tree on disk; it reads the git tree + the one `package.json` blob over
 *    the API (installation token for private repos, unauthenticated for public);
 *  - an uploaded archive is already extracted on the control plane during the
 *    deploy, so that tree is read straight off disk — no second extraction.
 *
 * A compose stack and a prebuilt Docker image have no framework to find: neither
 * runs a Deplo builder, so {@link supportsFrameworkDetection} already excludes
 * them before anything here is called.
 *
 * Every entry point is best-effort and non-throwing. Recognition is a label plus
 * a port default — never a reason to fail a deploy.
 */

/** Cap on how much of a `package.json` is read. Real manifests are a few KB; a
 * multi-megabyte one is either generated junk or a deliberate bomb, and the only
 * thing we want from it is its dependency names. */
const MAX_MANIFEST_BYTES = 1_000_000;

/**
 * Name the framework in a GitHub repo through the API. Works for a GitHub App
 * import (`source: "github"`, private repos via the installation token) AND a
 * plain github.com URL (`source: "git"`, read unauthenticated) — the repo, not
 * the `source` string, is what decides. `rootDirectory` selects the sub-app in a
 * monorepo. Null for a non-GitHub host: GitLab / Bitbucket / self-hosted git
 * have no tree-read path from the control plane, so those apps simply carry no
 * framework rather than a guessed one.
 */
export async function detectRepoFramework(
  repo: GitRepo,
  rootDirectory?: string | null,
): Promise<FrameworkId | null> {
  // A repo reached through a git connection is read with that connection's own
  // API, which is the same two calls in a different dialect (list the tree, read
  // one manifest). Tried first: a connection is explicit, while `isGithubRepo`
  // is a guess from the URL.
  if (repo.connectionId) {
    return detectViaConnection(repo, rootDirectory);
  }
  if (!isGithubRepo(repo)) return null;
  const fullName = githubFullName(repo);
  if (!fullName) return null;

  const tree = await listRepoTree(
    fullName,
    repo.branch?.trim() || "HEAD",
    repo.installationId ?? null,
  );
  if (tree.length === 0) return null;

  const rootRel = normalizeRootRel(rootDirectory);
  const files = rootFileNames(
    tree.map((entry) => entry.path),
    rootRel,
  );
  if (files.length === 0) return null;

  const manifestPath =
    rootRel && rootRel !== "." ? `${rootRel}/package.json` : "package.json";
  const manifestEntry = tree.find(
    (entry) => entry.path.toLowerCase() === manifestPath.toLowerCase(),
  );

  let manifest: PackageManifest | null = null;
  if (manifestEntry && manifestEntry.size <= MAX_MANIFEST_BYTES) {
    const bytes = await fetchRepoBlob(
      fullName,
      manifestEntry.sha,
      repo.installationId ?? null,
    );
    if (bytes) manifest = parsePackageManifest(bytes.toString("utf8"));
  }
  return detectFramework(files, manifest);
}

/**
 * The same recognition through a git connection's API. Best-effort and
 * non-throwing like every other arm: a provider that refuses the read leaves the
 * app with no framework rather than failing anything.
 */
async function detectViaConnection(
  repo: GitRepo,
  rootDirectory?: string | null,
): Promise<FrameworkId | null> {
  const cred = await readGitCredential(repo.connectionId!);
  const api = cred ? providerFor(cred.provider).api : null;
  if (!cred || !api || !repo.repo) return null;
  const ref = repo.branch?.trim() || "HEAD";

  const paths = await api.listTree(cred, repo.repo, ref).catch(() => []);
  if (paths.length === 0) return null;

  const rootRel = normalizeRootRel(rootDirectory);
  const files = rootFileNames(paths, rootRel);
  if (files.length === 0) return null;

  let manifest: PackageManifest | null = null;
  if (files.includes("package.json")) {
    const manifestPath =
      rootRel && rootRel !== "." ? `${rootRel}/package.json` : "package.json";
    const text = await readProviderText(
      api,
      cred,
      repo.repo,
      ref,
      manifestPath,
    ).catch(() => null);
    if (text) manifest = parsePackageManifest(text);
  }
  return detectFramework(files, manifest);
}

/** Entries scanned in one directory before we stop. The build root of a real app
 * holds tens of files; an archive is attacker-controlled, so the read of its root
 * is bounded like the favicon walk's is. */
const MAX_ROOT_ENTRIES = 5_000;

/**
 * Name the framework in an already-extracted source tree on local disk (the
 * upload arm). Only the build root's own entries are listed — one directory
 * read, never a descent — plus its `package.json` if present.
 */
export async function detectTreeFramework(
  root: string,
  rootDirectory?: string | null,
): Promise<FrameworkId | null> {
  // Same containment the BUILD uses (realpath-checked, symlink-proof): an
  // archive and its rootDirectory are both user-supplied, so resolving the
  // sub-path by hand here would be a second, weaker implementation of the one
  // rule that keeps a "../.." out of the host filesystem.
  const buildRoot = await resolveBuildDir({
    root,
    rootDirectory,
    failOnMissing: false,
  }).catch(() => root);

  const files: string[] = [];
  try {
    const dir = await opendir(buildRoot);
    // `for await` streams entries and closes the handle on completion AND on
    // `break`, so the cap can bail early without leaking a descriptor.
    for await (const entry of dir) {
      if (files.length >= MAX_ROOT_ENTRIES) break;
      if (entry.isFile()) files.push(entry.name.toLowerCase());
    }
  } catch {
    return null;
  }
  if (files.length === 0) return null;

  let manifest: PackageManifest | null = null;
  if (files.includes("package.json")) {
    const manifestPath = join(buildRoot, "package.json");
    const size = await stat(manifestPath)
      .then((s) => s.size)
      .catch(() => -1);
    if (size >= 0 && size <= MAX_MANIFEST_BYTES) {
      const text = await readFile(manifestPath, "utf8").catch(() => null);
      if (text) manifest = parsePackageManifest(text);
    }
  }
  return detectFramework(files, manifest);
}

/** The minimal app shape framework recognition reads. A loaded app graph
 * satisfies it structurally. */
export interface FrameworkDetectApp {
  source: string;
  repo?: GitRepo | null;
  build: Pick<BuildConfig, "buildMethod" | "rootDirectory">;
}

/**
 * Name the framework backing an app from whichever source it actually has —
 * the entry point the API uses. Null whenever there is nothing to read: a build
 * method that isn't one of the auto-detecting builders (the feature's one gate),
 * a compose stack, a prebuilt image, or a repo on a host the control plane can't
 * read.
 *
 * The UPLOAD arm is intentionally absent here: an archive is only extracted
 * during a deploy, and that deploy scans the tree it already has on disk (see
 * the deploy engine) instead of extracting an attacker-controlled archive a
 * second time to answer a question nobody asked.
 */
export async function detectAppFramework(
  app: FrameworkDetectApp,
): Promise<FrameworkId | null> {
  if (!supportsFrameworkDetection(app.build.buildMethod)) return null;
  if (!app.repo) return null;
  return detectRepoFramework(app.repo, app.build.rootDirectory);
}
