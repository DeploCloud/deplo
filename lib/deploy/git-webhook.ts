import type { GitTriggerType } from "@/lib/types";

/**
 * Pure, side-effect-free helpers the GitHub push webhook uses to decide whether a
 * verified delivery should auto-deploy a given app. Extracted from the route
 * handler so the trigger-type + watch-path logic is unit-testable without HTTP,
 * signatures, or a database.
 */

/** The parts of an inbound GitHub `push` delivery the trigger decision needs. */
export interface GitPushEvent {
  /** The ref is a tag (refs/tags/…) rather than a branch (refs/heads/…). */
  isTag: boolean;
  /** Short ref name: branch or tag without the refs/{heads,tags}/ prefix. */
  refName: string;
  /** A branch/tag deletion push (GitHub sets `deleted:true`, head_commit null). */
  deleted: boolean;
  /**
   * Union of files added/modified/removed across the delivery's commits. Empty
   * when the delivery carries no file list (an annotated-tag push, or a payload
   * with no `commits`), in which case the watch-path filter fails open.
   */
  changedPaths: string[];
}

/** An app's git deploy-trigger configuration (from the flattened repo_* row). */
export interface RepoTriggerConfig {
  /** The tracked branch (repo_branch || "main"). */
  branch: string;
  /** Which git event auto-deploys (repo_trigger_type || "push"). */
  triggerType: GitTriggerType;
  /** Parsed watch-path globs (repo_watch_paths). Empty ⇒ deploy on any change. */
  watchPaths: string[];
  /** The build root directory (app_build.root_directory). Only consulted when
   *  {@link skipUnchanged} is on. Empty/"."/unset ⇒ the whole repo is the root. */
  rootDirectory?: string | null;
  /** When true, an auto-deploy is skipped unless the push touched a file inside
   *  the root directory (app_build.skip_unchanged_deployments). */
  skipUnchanged?: boolean;
}

/** Normalise a rootDirectory to a clean forward-slash relative path with no
 *  leading `./` or `/`; `""`/`"."`/unset all collapse to `"."` (the repo root).
 *  Inlined (rather than importing `normalizeRootRel` from `source.ts`) to keep
 *  this module dependency-free — `source.ts` pulls in `node:fs`/`node:path`. */
function normalizeRoot(rootDirectory: string | null | undefined): string {
  return (rootDirectory || ".").replace(/\\/g, "/").replace(/^\.?\/?/, "");
}

/** The subset of GitHub's push payload the parser reads. */
export interface RawPushPayload {
  ref?: string;
  deleted?: boolean;
  head_commit?: {
    message?: string;
    added?: string[];
    modified?: string[];
    removed?: string[];
  } | null;
  commits?: Array<{
    added?: string[];
    modified?: string[];
    removed?: string[];
  }>;
}

/** Normalise a GitHub push payload into the fields the trigger decision needs. */
export function parsePushEvent(payload: RawPushPayload): GitPushEvent {
  const ref = payload.ref ?? "";
  const isTag = ref.startsWith("refs/tags/");
  const refName = ref.replace(/^refs\/(heads|tags)\//, "");
  const files = new Set<string>();
  const collect = (c?: {
    added?: string[];
    modified?: string[];
    removed?: string[];
  } | null) => {
    for (const f of c?.added ?? []) files.add(f);
    for (const f of c?.modified ?? []) files.add(f);
    for (const f of c?.removed ?? []) files.add(f);
  };
  for (const c of payload.commits ?? []) collect(c);
  collect(payload.head_commit);
  return {
    isTag,
    refName,
    deleted: payload.deleted === true,
    changedPaths: [...files],
  };
}

/**
 * Whether a verified push should trigger an automatic deployment for an app
 * whose auto-deploy is already on. Encapsulates trigger-type gating (push vs new
 * tag) and the optional watch-path filter.
 */
export function shouldAutoDeploy(
  cfg: RepoTriggerConfig,
  ev: GitPushEvent,
): boolean {
  // A ref deletion never deploys (no code to build).
  if (ev.deleted) return false;

  if (cfg.triggerType === "tag") {
    // "On new tag": only tag pushes qualify; the branch is irrelevant.
    if (!ev.isTag) return false;
  } else {
    // "On push": only a push to the tracked branch qualifies (tags ignored).
    if (ev.isTag) return false;
    if (ev.refName !== cfg.branch) return false;
  }

  // Watch-path filter — only gate when we have BOTH globs and a known file list.
  // A delivery with no file list (annotated-tag push) falls open, matching the
  // "best effort" contract documented on GitRepo.watchPaths.
  if (cfg.watchPaths.length > 0 && ev.changedPaths.length > 0) {
    return ev.changedPaths.some((f) => pathMatchesAnyGlob(f, cfg.watchPaths));
  }

  // "Skip when the root directory is untouched" — like an implicit watch path of
  // the root directory. Only gates when the option is on, an explicit root dir is
  // set, and we actually have a file list (a fileless delivery falls open, same
  // contract as the watch-path filter). A path INSIDE the root dir keeps it.
  //
  // Reached only when no EXPLICIT watch-path allowlist matched above (that branch
  // early-returns): a user who authored watch paths has taken direct control of
  // path filtering, so their allowlist wins over this root-directory heuristic.
  if (cfg.skipUnchanged && ev.changedPaths.length > 0) {
    const root = normalizeRoot(cfg.rootDirectory);
    if (root && root !== ".") {
      return ev.changedPaths.some((f) => pathMatchesGlob(normalizePath(f), root));
    }
  }
  return true;
}

/** True when `path` matches at least one of the glob patterns. */
export function pathMatchesAnyGlob(path: string, globs: string[]): boolean {
  const p = normalizePath(path);
  return globs.some((g) => pathMatchesGlob(p, normalizePath(g)));
}

function normalizePath(p: string): string {
  return p.trim().replace(/^\.?\//, "");
}

/**
 * Match a single (already-normalised) path against one glob.
 *  - A pattern with no wildcard is a literal file OR directory-prefix match
 *    ("src" matches "src" and "src/app.ts").
 *  - Otherwise `**` matches across `/`, `*` matches within a segment, `?` matches
 *    one non-`/` char. All other characters are matched literally.
 */
export function pathMatchesGlob(path: string, glob: string): boolean {
  if (!glob) return false;
  if (!/[*?]/.test(glob)) {
    const dir = glob.replace(/\/$/, "");
    return path === dir || path.startsWith(dir + "/");
  }
  return globToRegExp(glob).test(path);
}

function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          // "**/" matches zero or more WHOLE leading path segments — anchored to a
          // "/" boundary so "**/config.json" matches "config.json" and "a/b/config.json"
          // but NOT "myconfig.json" (the leading part must end at a separator).
          re += "(?:.*/)?";
          i++;
        } else {
          // A bare "**" matches anything, including path separators.
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp("^" + re + "$");
}
