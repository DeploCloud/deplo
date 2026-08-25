/**
 * The deploy-source seam: decide WHICH source a deployment builds from, and the
 * shared rootDirectory resolution every built source uses.
 */

import { join } from "node:path";
import { realpath } from "node:fs/promises";
import { safeBuildDir } from "./path-safety";
import type { GitRepo, UploadArchive } from "../types";

/**
 * What a deployment builds from, decided from the project. Each variant CARRIES
 * the data its execution needs, so the engine never re-derives (or
 * non-null-asserts) what the decision already proved present.
 */
export type SourcePlan =
  | { kind: "docker-image"; image: string }
  | { kind: "git"; repo: GitRepo }
  | { kind: "upload"; upload: UploadArchive }
  | { kind: "none" };

/** The minimal project shape the source decision reads. A `App` satisfies
 * this structurally; kept narrow so the decision stays free of the store graph. */
export interface SourcePlanApp {
  source: string;
  dockerImage?: string | null;
  repo?: GitRepo | null;
  upload?: UploadArchive | null;
}

/**
 * Decide which source a deployment builds from. The project's `source` drives
 * the choice; a docker-image needs an image set, git needs a repo, upload needs
 * an archive.
 */
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

/** Normalise a user-supplied rootDirectory to a clean forward-slash relative
 * path: backslashes → slashes, a leading `./` or `/` stripped. `""`/`"."`/unset
 * all mean "the tree root". Pure. */
export function normalizeRootRel(
  rootDirectory: string | null | undefined,
): string {
  return (rootDirectory || ".").replace(/\\/g, "/").replace(/^\.?\/?/, "");
}

/** Whether a normalised rootRel names an explicit subdirectory (not the root).
 * An explicit-but-missing rootDirectory is a misconfiguration the caller fails
 * loudly on; an absent one silently builds the tree root. Pure. */
export function isExplicitRoot(rootRel: string): boolean {
  return Boolean(rootRel && rootRel !== ".");
}

/** Thrown when an explicitly-set rootDirectory isn't found in the materialised
 * tree. Carries the source-specific message the engine surfaces to the user. */
export class RootDirectoryNotFound extends Error {}

/**
 * Resolve the directory to build from inside a materialised tree (`root`),
 * containing a user-supplied `rootDirectory` against it via {@link safeBuildDir}
 * (realpath-based, defeats symlink escape).
 */
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
