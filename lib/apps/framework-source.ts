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
  productionStartCommand,
  rootFileNames,
  type DetectedCommands,
  type PackageManifest,
} from "./framework-detect";
import type { GitRepo } from "../types/build";

const MAX_MANIFEST_BYTES = 1_000_000;

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
    startCommand:
      derived.startCommand ??
      productionStartCommand(files, manifest, framework),
    ...detectCommands(files, manifest),
  };
}

// The files at the app's root in its repo, and a way to read one: GitHub or a connected provider.
export interface RepoRoot {
  files: string[];
  read(name: string): Promise<string | null>;
}

export async function openRepoRoot(
  repo: GitRepo,
  rootDirectory?: string | null,
): Promise<RepoRoot | null> {
  if (repo.connectionId) return openViaConnection(repo, rootDirectory);
  if (!isGithubRepo(repo)) return null;
  const fullName = githubFullName(repo);
  if (!fullName) return null;

  const installationId =
    repo.installationId ?? (await activeTeamInstallationId());
  const tree = await listRepoTree(
    fullName,
    repo.branch?.trim() || "HEAD",
    installationId,
  );
  if (tree.length === 0) return null;

  const rootRel = normalizeRootRel(rootDirectory);
  const files = rootFileNames(
    tree.map((entry) => entry.path),
    rootRel,
  );
  if (files.length === 0) return null;

  return {
    files,
    read: async (name) => {
      const path = rootRel && rootRel !== "." ? `${rootRel}/${name}` : name;
      const entry = tree.find(
        (e) => e.path.toLowerCase() === path.toLowerCase(),
      );
      if (!entry || entry.size > MAX_MANIFEST_BYTES) return null;
      const bytes = await fetchRepoBlob(fullName, entry.sha, installationId);
      return bytes ? bytes.toString("utf8") : null;
    },
  };
}

async function openViaConnection(
  repo: GitRepo,
  rootDirectory?: string | null,
): Promise<RepoRoot | null> {
  const cred = await readGitCredential(repo.connectionId!);
  const api = cred ? providerFor(cred.provider).api : null;
  if (!cred || !api || !repo.repo) return null;
  const ref = repo.branch?.trim() || "HEAD";

  const paths = await api.listTree(cred, repo.repo, ref).catch(() => []);
  if (paths.length === 0) return null;

  const rootRel = normalizeRootRel(rootDirectory);
  const files = rootFileNames(paths, rootRel);
  if (files.length === 0) return null;

  return {
    files,
    read: async (name) =>
      files.includes(name)
        ? readProviderText(
            api,
            cred,
            repo.repo!,
            ref,
            rootRel && rootRel !== "." ? `${rootRel}/${name}` : name,
          ).catch(() => null)
        : null,
  };
}

export async function detectRepoFramework(
  repo: GitRepo,
  rootDirectory?: string | null,
): Promise<RepoBuildHints> {
  const root = await openRepoRoot(repo, rootDirectory);
  if (!root) return NO_HINTS;
  const manifestText = await root.read("package.json");
  const manifest = manifestText ? parsePackageManifest(manifestText) : null;
  const angularJson = root.files.includes("angular.json")
    ? await root.read("angular.json")
    : null;
  return hintsFor(root.files, manifest, angularJson);
}

async function activeTeamInstallationId(): Promise<string | null> {
  return listGithubInstallations()
    .then((rows) => rows[0]?.id ?? null)
    .catch(() => null);
}

const MAX_ROOT_ENTRIES = 5_000;

export async function detectTreeFramework(
  root: string,
  rootDirectory?: string | null,
): Promise<FrameworkId | null> {
  const buildRoot = await resolveBuildDir({
    root,
    rootDirectory,
    failOnMissing: false,
  }).catch(() => root);

  const files: string[] = [];
  try {
    const dir = await opendir(buildRoot);
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
