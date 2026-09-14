import "server-only";

import { opendir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { listRepoTree, fetchRepoBlob } from "../github/app";
import { listGithubInstallations } from "../data/github";
import { githubFullName } from "../github/repo-id";
import { readGitCredential } from "../data/git-connections";
import { readProviderText } from "../git/providers/api-client";
import { providerFor } from "../git/providers/registry";
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
import type { GitRepo } from "../types/build";

// A multi-megabyte manifest is generated junk or a bomb; only its dependency names are wanted.
const MAX_MANIFEST_BYTES = 1_000_000;

// RepoBuildHints - what one read of a repository's build root yields; every field is best-effort.
export interface RepoBuildHints extends DetectedCommands {
  framework: FrameworkId | null;
  staticOutput: string | null;
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

// detectRepoFramework - read a GitHub repo's build root through the API: its framework and its own commands.
export async function detectRepoFramework(
  repo: GitRepo,
  rootDirectory?: string | null,
): Promise<RepoBuildHints> {
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

// Unauthenticated GitHub is 60 requests an hour for the whole instance; an installation token reads public repos at 5000.
async function activeTeamInstallationId(): Promise<string | null> {
  // Never another team's: its token would also open that team's PRIVATE repos.
  return listGithubInstallations()
    .then((rows) => rows[0]?.id ?? null)
    .catch(() => null);
}

// An archive is attacker-controlled, so the read of its root is bounded like the favicon walk's is.
const MAX_ROOT_ENTRIES = 5_000;

// detectTreeFramework - the framework in an already-extracted source tree; one directory read, never a descent.
export async function detectTreeFramework(
  root: string,
  rootDirectory?: string | null,
): Promise<FrameworkId | null> {
  // resolveBuildDir is the realpath-checked containment the build uses; never resolve the sub-path by hand.
  const buildRoot = await resolveBuildDir({
    root,
    rootDirectory,
    failOnMissing: false,
  }).catch(() => root);

  const files: string[] = [];
  try {
    const dir = await opendir(buildRoot);
    // `for await` closes the handle on completion and on `break`, so the cap leaks no descriptor.
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
