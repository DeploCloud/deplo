import { join } from "node:path";
import { realpath } from "node:fs/promises";
import { safeBuildDir } from "./path-safety";
import type { UploadArchive } from "../types/app";
import type { GitRepo } from "../types/build";

export type SourcePlan =
  | { kind: "docker-image"; image: string }
  | { kind: "git"; repo: GitRepo }
  | { kind: "upload"; upload: UploadArchive }
  | { kind: "none" };

export interface SourcePlanApp {
  source: string;
  dockerImage?: string | null;
  repo?: GitRepo | null;
  upload?: UploadArchive | null;
}

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

export function normalizeRootRel(
  rootDirectory: string | null | undefined,
): string {
  return (rootDirectory || ".").replace(/\\/g, "/").replace(/^\.?\/?/, "");
}

export function isExplicitRoot(rootRel: string): boolean {
  return Boolean(rootRel && rootRel !== ".");
}

export class RootDirectoryNotFound extends Error {}

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
