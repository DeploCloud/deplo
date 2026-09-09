import "server-only";

import { opendir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { listRepoTree, fetchRepoBlob } from "../github/app";
import { listGithubInstallations } from "../data/github";
import { githubFullName } from "../github/repo-id";
import { readGitCredential } from "../data/git-connections";
import { providerFor, readProviderText } from "../git/providers";
import { normalizeRootRel, resolveBuildDir } from "../deploy/source";
import { isGithubRepo } from "./favicon-shared";
import { frameworkById, type FrameworkId } from "./framework-catalog";
import {
  angularOutputDir,
  declaredDependencies,
  detectCommands,
  frameworkDefaults,
  detectFramework,
  parsePackageManifest,
  rootFileNames,
  type DetectedCommands,
  type PackageManifest,
} from "./framework-detect";
import type { GitRepo } from "../types";

/**
 * Reading an app's own source to name its framework - the server-only I/O around
 * the pure rules in {@link file://. Recognition is a label plus a port default,
 * never a reason to fail a deploy.
 */

/** Cap on how much of a `package.json` is read. Real manifests are a few KB; a
 * multi-megabyte one is either generated junk or a deliberate bomb, and the only
 * thing we want from it is its dependency names. */
const MAX_MANIFEST_BYTES = 1_000_000;

/**
 * What one read of a repository's build root yields: the framework backing it,
 * plus the build command it declares for ITSELF. Both are best-effort and both
 * can be null.
 */
export interface RepoBuildHints extends DetectedCommands {
  framework: FrameworkId | null;
  /** The directory to SERVE, when the framework builds one and runs no server. */
  staticOutput: string | null;
  /** The framework's own production start, when no builder derives one. */
  startCommand: string | null;
}

const NO_HINTS: RepoBuildHints = {
  framework: null,
  staticOutput: null,
  startCommand: null,
  buildCommand: null,
};

function hintsFor(
  files: readonly string[],
  manifest: PackageManifest | null,
  angularJson?: string | null,
): RepoBuildHints {
  const framework = detectFramework(files, manifest);
  const derived = frameworkDefaults(framework, declaredDependencies(manifest));
  return {
    framework,
    staticOutput:
      framework === "angular"
        ? angularJson
          ? angularOutputDir(angularJson)
          : null
        : (derived.staticOutput ??
          frameworkById(framework)?.staticOutput ??
          null),
    startCommand: derived.startCommand,
    ...detectCommands(files, manifest),
  };
}

/**
 * Read a GitHub repo's build root through the API: what framework it is, and
 * what it says its own build and start commands are.
 */
export async function detectRepoFramework(
  repo: GitRepo,
  rootDirectory?: string | null,
): Promise<RepoBuildHints> {
  // A repo reached through a git connection is read with that connection's own API,
  // which is the same two calls in a different dialect (list the tree, read one
  // manifest).
  if (repo.connectionId) {
    return detectViaConnection(repo, rootDirectory);
  }
  if (!isGithubRepo(repo)) return NO_HINTS;
  const fullName = githubFullName(repo);
  if (!fullName) return NO_HINTS;

  const installationId =
    repo.installationId ?? (await activeTeamInstallationId());
  const tree = await listRepoTree(
    fullName,
    repo.branch?.trim() || "HEAD",
    installationId,
  );
  if (tree.length === 0) return NO_HINTS;

  const rootRel = normalizeRootRel(rootDirectory);
  const files = rootFileNames(
    tree.map((entry) => entry.path),
    rootRel,
  );
  if (files.length === 0) return NO_HINTS;

  const blobAt = async (name: string): Promise<string | null> => {
    const path = rootRel && rootRel !== "." ? `${rootRel}/${name}` : name;
    const entry = tree.find((e) => e.path.toLowerCase() === path.toLowerCase());
    if (!entry || entry.size > MAX_MANIFEST_BYTES) return null;
    const bytes = await fetchRepoBlob(fullName, entry.sha, installationId);
    return bytes ? bytes.toString("utf8") : null;
  };

  const manifestText = await blobAt("package.json");
  const manifest = manifestText ? parsePackageManifest(manifestText) : null;
  const angularJson = files.includes("angular.json")
    ? await blobAt("angular.json")
    : null;
  return hintsFor(files, manifest, angularJson);
}

/**
 * The same recognition through a git connection's API. Best-effort and
 * non-throwing like every other arm: a provider that refuses the read leaves the
 * app with no framework rather than failing anything.
 */
async function detectViaConnection(
  repo: GitRepo,
  rootDirectory?: string | null,
): Promise<RepoBuildHints> {
  const cred = await readGitCredential(repo.connectionId!);
  const api = cred ? providerFor(cred.provider).api : null;
  if (!cred || !api || !repo.repo) return NO_HINTS;
  const ref = repo.branch?.trim() || "HEAD";

  const paths = await api.listTree(cred, repo.repo, ref).catch(() => []);
  if (paths.length === 0) return NO_HINTS;

  const rootRel = normalizeRootRel(rootDirectory);
  const files = rootFileNames(paths, rootRel);
  if (files.length === 0) return NO_HINTS;

  const textAt = (name: string) =>
    readProviderText(
      api,
      cred,
      repo.repo!,
      ref,
      rootRel && rootRel !== "." ? `${rootRel}/${name}` : name,
    ).catch(() => null);

  const manifestText = files.includes("package.json")
    ? await textAt("package.json")
    : null;
  const manifest = manifestText ? parsePackageManifest(manifestText) : null;
  const angularJson = files.includes("angular.json")
    ? await textAt("angular.json")
    : null;
  return hintsFor(files, manifest, angularJson);
}

/**
 * A GitHub App installation of the ACTIVE TEAM, for a repo the caller named no
 * installation for. Unauthenticated GitHub is 60 requests an HOUR for the whole
 * instance, so without this recognition silently reads nothing on a busy day; an
 * installation token reads any PUBLIC repo too, at 5000.
 */
async function activeTeamInstallationId(): Promise<string | null> {
  // Never another team's: its token would also open that team's PRIVATE repos.
  return listGithubInstallations()
    .then((rows) => rows[0]?.id ?? null)
    .catch(() => null);
}

/** Entries scanned in one directory before we stop. The build root of a real app
 * holds tens of files; an archive is attacker-controlled, so the read of its root
 * is bounded like the favicon walk's is. */
const MAX_ROOT_ENTRIES = 5_000;

/**
 * Name the framework in an already-extracted source tree on local disk (the
 * upload arm). Only the build root's own entries are listed - one directory
 * read, never a descent - plus its `package.json` if present.
 */
export async function detectTreeFramework(
  root: string,
  rootDirectory?: string | null,
): Promise<FrameworkId | null> {
  // Same containment the BUILD uses (realpath-checked, symlink-proof): an archive and
  // its rootDirectory are both user-supplied, so resolving the sub-path by hand here
  // would be a second, weaker implementation of the one rule that keeps a "..
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
