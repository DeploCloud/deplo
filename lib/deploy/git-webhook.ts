import type { GitTriggerType } from "@/lib/types/build";

export interface GitPushEvent {
  isTag: boolean;
  refName: string;
  deleted: boolean;
  changedPaths: string[];
}

export interface RepoTriggerConfig {
  branch: string;
  triggerType: GitTriggerType;
  watchPaths: string[];
  rootDirectory?: string | null;
  skipUnchanged?: boolean;
}

function normalizeRoot(rootDirectory: string | null | undefined): string {
  return (rootDirectory || ".").replace(/\\/g, "/").replace(/^\.?\/?/, "");
}

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

export function pathMatchesAnyGlob(path: string, globs: string[]): boolean {
  const p = normalizePath(path);
  return globs.some((g) => pathMatchesGlob(p, normalizePath(g)));
}

function normalizePath(p: string): string {
  return p.trim().replace(/^\.?\//, "");
}

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
