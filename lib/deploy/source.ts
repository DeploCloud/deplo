import { join } from "node:path";
import { realpath } from "node:fs/promises";
import { safeBuildDir } from "./path-safety";
import type { UploadArchive } from "../types/app";
import type { GitRepo } from "../types/build";

// SourcePlan - what a deployment builds from; each variant carries its execution data.
export type SourcePlan =
  | { kind: "docker-image"; image: string }
  | { kind: "git"; repo: GitRepo }
  | { kind: "upload"; upload: UploadArchive }
  | { kind: "none" };

// SourcePlanApp - the minimal project shape the source decision reads.
export interface SourcePlanApp {
  source: string;
  dockerImage?: string | null;
  repo?: GitRepo | null;
  upload?: UploadArchive | null;
}

// planDeploySource - decide which source a deployment builds from.
export function planDeploySource(project: SourcePlanApp): SourcePlan {
  if (project.source === "docker-image" && project.dockerImage) {
    return { kind: "docker-image", image: project.dockerImage };
  }
  if (project.repo) return { kind: "git", repo: project.repo };
  if (project.source === "upload" && project.upload) {
    return { kind: "upload", upload: project.upload };
  }
  return { kind: "none" };
}

// normalizeRootRel - clean forward-slash relative path; "", "." and unset mean the tree root.
export function normalizeRootRel(
  rootDirectory: string | null | undefined,
): string {
  return (rootDirectory || ".").replace(/\\/g, "/").replace(/^\.?\/?/, "");
}

// isExplicitRoot - whether a normalised rootRel names an explicit subdirectory.
export function isExplicitRoot(rootRel: string): boolean {
  return Boolean(rootRel && rootRel !== ".");
}

// RootDirectoryNotFound - thrown when an explicitly-set rootDirectory isn't in the tree.
export class RootDirectoryNotFound extends Error {}

// resolveBuildDir - contains rootDirectory inside the tree via safeBuildDir (defeats symlink escape).
export async function resolveBuildDir(opts: {
  root: string;
  rootDirectory: string | null | undefined;
  failOnMissing: boolean;
  notFoundMessage?: string;
}): Promise<string> {
  const rootRel = normalizeRootRel(opts.rootDirectory);
  const explicit = isExplicitRoot(rootRel);
  const candidate = explicit ? join(opts.root, rootRel) : opts.root;
  const buildDir = await safeBuildDir(opts.root, candidate);
  if (opts.failOnMissing && explicit) {
    const realRoot = await realpath(opts.root).catch(() => opts.root);
    if (buildDir === realRoot) {
      throw new RootDirectoryNotFound(
        opts.notFoundMessage ??
          `rootDirectory "${opts.rootDirectory}" was not found`,
      );
    }
  }
  return buildDir;
}
