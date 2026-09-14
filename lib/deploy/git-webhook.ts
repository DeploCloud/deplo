// https://deplo.build/docs/guides/releases/automatic-deployments

import type { GitTriggerType } from "@/lib/types/build";

/** The parts of an inbound GitHub `push` delivery the trigger decision needs. */
export interface GitPushEvent {
  /** The ref is a tag (refs/tags/…) rather than a branch (refs/heads/…). */
  isTag: boolean;
  /** Short ref name: branch or tag without the refs/{heads,tags}/ prefix. */
  refName: string;
  /** A branch/tag deletion push (GitHub sets `deleted:true`, head_commit null). */
  deleted: boolean;
  /** Union of files across the delivery's commits. Empty ⇒ the watch-path filter fails open. */
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
  /** The build root directory. Only consulted when {@link skipUnchanged} is on. */
  rootDirectory?: string | null;
  /** Skip an auto-deploy unless the push touched a file inside the root directory. */
  skipUnchanged?: boolean;
}

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
  const collect = (
    c?: {
      added?: string[];
      modified?: string[];
      removed?: string[];
    } | null,
  ) => {
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

/** Whether a verified push should trigger an automatic deployment for an app whose auto-deploy is on. */
export function shouldAutoDeploy(
  cfg: RepoTriggerConfig,
  ev: GitPushEvent,
): boolean {
  if (ev.deleted) return false;

  if (cfg.triggerType === "tag") {
    if (!ev.isTag) return false;
  } else {
    if (ev.isTag) return false;
    if (ev.refName !== cfg.branch) return false;
  }

  // Fails open on a delivery with no file list (annotated-tag push) - the documented best-effort contract.
  if (cfg.watchPaths.length > 0 && ev.changedPaths.length > 0) {
    return ev.changedPaths.some((f) => pathMatchesAnyGlob(f, cfg.watchPaths));
  }

  if (cfg.skipUnchanged && ev.changedPaths.length > 0) {
    const root = normalizeRoot(cfg.rootDirectory);
    if (root && root !== ".") {
      return ev.changedPaths.some((f) =>
        pathMatchesGlob(normalizePath(f), root),
      );
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

/** Match a single (already-normalised) path against one glob. */
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
          // "**/" matches zero or more WHOLE leading segments: "**/c.json" matches "c.json", not "myc.json".
          re += "(?:.*/)?";
          i++;
        } else {
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
