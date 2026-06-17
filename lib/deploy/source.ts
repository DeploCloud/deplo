/**
 * The deploy-source seam: decide WHICH source a deployment builds from, and the
 * shared rootDirectory resolution every built source uses.
 *
 * `runDeployment` used to inline a 5-way `if/else` over the source (dev-workspace
 * / docker-image / git / upload / compose) with the rootDirectory logic copied
 * into three arms. The DECISION (which path, and why) is pulled out here as a
 * pure function so it can be exercised without a clone, an archive, or docker;
 * the EXECUTION of each plan stays in the engine (it needs the filesystem and
 * docker). The split is the point: the branchy part is now testable in isolation.
 *
 * Pure on purpose (no store, no docker, no `server-only`) except
 * `resolveBuildDir`, which is the one shared filesystem touch — it wraps
 * `safeBuildDir` so every built source contains rootDirectory the same way.
 */

import { join } from "node:path";
import { realpath } from "node:fs/promises";
import { safeBuildDir } from "./path-safety";
import type { GitRepo, UploadArchive } from "../types";

/** What a deployment builds from, decided from the project + deployment intent.
 * Each variant CARRIES the data its execution needs, so the engine never
 * re-derives (or non-null-asserts) what the decision already proved present.
 *  - `dev-workspace` — build PRODUCTION from the live dev tree (explicit intent,
 *    overrides the project's own source; CONTEXT.md exception).
 *  - `docker-image`  — pull a prebuilt image; no build, no tree.
 *  - `git` / `upload` — materialise a tree, then build it.
 *  - `none`          — nothing deployable; the engine errors. */
export type SourcePlan =
  | { kind: "dev-workspace" }
  | { kind: "docker-image"; image: string }
  | { kind: "git"; repo: GitRepo }
  | { kind: "upload"; upload: UploadArchive }
  | { kind: "none" };

/** The minimal project shape the source decision reads. A `Project` satisfies
 * this structurally; kept narrow so the decision stays free of the store graph. */
export interface SourcePlanProject {
  source: string;
  dockerImage?: string | null;
  repo?: GitRepo | null;
  upload?: UploadArchive | null;
}

/**
 * Decide which source a deployment builds from. `buildSource: "dev-workspace"`
 * is checked FIRST because it is an explicit intent that OVERRIDES the project's
 * own source (a git/upload project deploys its edited workspace here, not a
 * fresh clone). Otherwise the project's `source` drives the choice; a
 * docker-image needs an image set, git needs a repo, upload needs an archive.
 */
export function planDeploySource(
  project: SourcePlanProject,
  opts: { buildSource?: "dev-workspace" },
): SourcePlan {
  if (opts.buildSource === "dev-workspace") return { kind: "dev-workspace" };
  if (project.source === "docker-image" && project.dockerImage) {
    return { kind: "docker-image", image: project.dockerImage };
  }
  if (project.repo) return { kind: "git", repo: project.repo };
  if (project.source === "upload" && project.upload) {
    return { kind: "upload", upload: project.upload };
  }
  return { kind: "none" };
}

/**
 * Whether a "deploy from dev workspace" intent is allowed for this project. Dev
 * is source-bearing only (git/upload), so this is always a single-image build; a
 * compose stack or a docker-image project has no buildable workspace tree. Guards
 * against a future source change silently routing a stack through the dev arm.
 */
export function devWorkspaceDeployAllowed(opts: {
  usesComposeStack: boolean;
  source: string;
}): boolean {
  return !opts.usesComposeStack && opts.source !== "docker-image";
}

/** Normalise a user-supplied rootDirectory to a clean forward-slash relative
 * path: backslashes → slashes, a leading `./` or `/` stripped. `""`/`"."`/unset
 * all mean "the tree root". Pure. */
export function normalizeRootRel(rootDirectory: string | null | undefined): string {
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
 * (realpath-based, defeats symlink escape). The one place every built source
 * (git, upload, dev-workspace) resolves rootDirectory, so they can never drift.
 *
 * When `failOnMissing` is set and an EXPLICIT rootDirectory resolves back to the
 * tree root (i.e. it wasn't found / escaped), throws {@link RootDirectoryNotFound}
 * with `notFoundMessage` — a typo'd path must fail loudly rather than silently
 * shipping the wrong tree. `upload` historically did NOT hard-fail, so it passes
 * `failOnMissing: false` to preserve that behaviour.
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
