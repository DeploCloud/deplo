import type { SourceFile } from "../clone-archive";
import type { GitProviderId } from "../../types/git";

import { call, json } from "./api-client";
import { bbAuth } from "./bitbucket";
import { giAuth } from "./gitea";
import { glAuth } from "./gitlab";
import type { GitCredential } from "./types";

// Deplo only ever CREATES a repository and writes its first commit: there is no delete here, on purpose.
export interface RepoOwner {
  id: string;
  login: string;
  personal: boolean;
  avatarUrl: string;
}

export interface NewRepoSpec {
  name: string;
  private: boolean;
  description: string;
  message: string;
}

export interface CreatedRepo {
  fullName: string;
  url: string;
  branch: string;
}

export interface RepoCreator {
  listOwners(c: GitCredential): Promise<RepoOwner[]>;
  create(
    c: GitCredential,
    owner: RepoOwner,
    spec: NewRepoSpec,
    files: SourceFile[],
  ): Promise<CreatedRepo>;
}

const BRANCH = "main";
const PUSH_TIMEOUT_MS = 120_000;
const BATCH_BYTES = 8 * 1024 * 1024;
const BATCH_FILES = 500;

// Several commits when the project is large: one request per commit, and hosts cap a request's size.
export function batches<T extends { bytes: Buffer }>(
  files: T[],
  maxBytes = BATCH_BYTES,
  maxFiles = BATCH_FILES,
): T[][] {
  const out: T[][] = [];
  let current: T[] = [];
  let size = 0;
  for (const f of files) {
    const weight = Math.ceil((f.bytes.length * 4) / 3);
    if (
      current.length > 0 &&
      (size + weight > maxBytes || current.length >= maxFiles)
    ) {
      out.push(current);
      current = [];
      size = 0;
    }
    current.push(f);
    size += weight;
  }
  if (current.length > 0) out.push(current);
  return out;
}

export function nameTaken(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return /\((400|409|422)\)/.test(m) && /already|taken|exists/i.test(m);
}

function takenError(owner: RepoOwner, name: string): Error {
  return new Error(
    `${owner.login} already has a repository called ${name}. Pick another name.`,
  );
}

const gitlabCreator: RepoCreator = {
  async listOwners(c) {
    const rows = await json<
      {
        id: number;
        full_path: string;
        kind: string;
        avatar_url?: string | null;
      }[]
    >(c, "/api/v4/namespaces?per_page=100", { auth: glAuth(c) });
    return rows.map((r) => ({
      id: String(r.id),
      login: r.full_path,
      personal: r.kind === "user",
      avatarUrl: r.avatar_url ?? "",
    }));
  },

  async create(c, owner, spec, files) {
    const project = await json<{
      id: number;
      path_with_namespace: string;
      web_url: string;
    }>(c, "/api/v4/projects", {
      auth: glAuth(c),
      method: "POST",
      body: JSON.stringify({
        name: spec.name,
        path: spec.name,
        namespace_id: Number(owner.id),
        visibility: spec.private ? "private" : "public",
        description: spec.description.slice(0, 2000),
      }),
    }).catch((e) => {
      throw nameTaken(e) ? takenError(owner, spec.name) : e;
    });
    for (const [i, batch] of batches(files).entries()) {
      await call(c, `/api/v4/projects/${project.id}/repository/commits`, {
        auth: glAuth(c),
        method: "POST",
        timeoutMs: PUSH_TIMEOUT_MS,
        body: JSON.stringify({
          branch: BRANCH,
          commit_message:
            i === 0 ? spec.message : `${spec.message} (continued)`,
          actions: batch.map((f) => ({
            action: "create",
            file_path: f.path,
            content: f.bytes.toString("base64"),
            encoding: "base64",
            ...(f.executable ? { execute_filemode: true } : {}),
          })),
        }),
      });
    }
    return {
      fullName: project.path_with_namespace,
      url: project.web_url,
      branch: BRANCH,
    };
  },
};

const giteaCreator: RepoCreator = {
  async listOwners(c) {
    const me = await json<{ id: number; login: string; avatar_url?: string }>(
      c,
      "/api/v1/user",
      { auth: giAuth(c) },
    );
    const orgs = await json<
      { id: number; username?: string; name?: string; avatar_url?: string }[]
    >(c, "/api/v1/user/orgs?limit=50", { auth: giAuth(c) }).catch(() => []);
    return [
      {
        id: String(me.id),
        login: me.login,
        personal: true,
        avatarUrl: me.avatar_url ?? "",
      },
      ...orgs.map((o) => ({
        id: String(o.id),
        login: o.username || o.name || "",
        personal: false,
        avatarUrl: o.avatar_url ?? "",
      })),
    ].filter((o) => o.login);
  },

  async create(c, owner, spec, files) {
    const path = owner.personal
      ? "/api/v1/user/repos"
      : `/api/v1/orgs/${encodeURIComponent(owner.login)}/repos`;
    const repo = await json<{ full_name: string; html_url: string }>(c, path, {
      auth: giAuth(c),
      method: "POST",
      body: JSON.stringify({
        name: spec.name,
        private: spec.private,
        description: spec.description.slice(0, 2000),
        auto_init: false,
        default_branch: BRANCH,
      }),
    }).catch((e) => {
      throw nameTaken(e) ? takenError(owner, spec.name) : e;
    });
    for (const [i, batch] of batches(files).entries()) {
      await call(c, `/api/v1/repos/${repo.full_name}/contents`, {
        auth: giAuth(c),
        method: "POST",
        timeoutMs: PUSH_TIMEOUT_MS,
        body: JSON.stringify({
          branch: BRANCH,
          message: i === 0 ? spec.message : `${spec.message} (continued)`,
          files: batch.map((f) => ({
            operation: "create",
            path: f.path,
            content: f.bytes.toString("base64"),
          })),
        }),
      });
    }
    return { fullName: repo.full_name, url: repo.html_url, branch: BRANCH };
  },
};

const bitbucketCreator: RepoCreator = {
  async listOwners(c) {
    type Ws = {
      slug?: string;
      name?: string;
      links?: { avatar?: { href?: string } };
    };
    const res = await json<{ values?: ({ workspace?: Ws } & Ws)[] }>(
      c,
      "/2.0/user/workspaces?pagelen=100",
      { auth: bbAuth(c) },
    ).catch(() =>
      json<{ values?: { workspace?: Ws }[] }>(
        c,
        "/2.0/user/permissions/workspaces?pagelen=100",
        { auth: bbAuth(c) },
      ),
    );
    return (res.values ?? [])
      .map((v) => v.workspace ?? (v as Ws))
      .filter((w): w is Ws & { slug: string } => Boolean(w.slug))
      .map((w) => ({
        id: w.slug,
        login: w.slug,
        personal: false,
        avatarUrl: w.links?.avatar?.href ?? "",
      }));
  },

  async create(c, owner, spec, files) {
    const slug = spec.name.toLowerCase();
    const fullName = `${owner.login}/${slug}`;
    const repo = await json<{
      full_name: string;
      links?: { html?: { href?: string } };
    }>(c, `/2.0/repositories/${fullName}`, {
      auth: bbAuth(c),
      method: "POST",
      body: JSON.stringify({
        scm: "git",
        is_private: spec.private,
        description: spec.description.slice(0, 2000),
      }),
    }).catch((e) => {
      throw nameTaken(e) ? takenError(owner, slug) : e;
    });
    for (const [i, batch] of batches(files).entries()) {
      const form = new FormData();
      form.set(
        "message",
        i === 0 ? spec.message : `${spec.message} (continued)`,
      );
      form.set("branch", BRANCH);
      for (const f of batch)
        form.set(`/${f.path}`, new Blob([new Uint8Array(f.bytes)]), f.path);
      await call(c, `/2.0/repositories/${fullName}/src`, {
        auth: bbAuth(c),
        method: "POST",
        timeoutMs: PUSH_TIMEOUT_MS,
        body: form,
      });
    }
    return {
      fullName: repo.full_name,
      url: repo.links?.html?.href ?? `https://bitbucket.org/${fullName}`,
      branch: BRANCH,
    };
  },
};

const CREATORS: Partial<Record<GitProviderId, RepoCreator>> = {
  gitlab: gitlabCreator,
  gitea: giteaCreator,
  bitbucket: bitbucketCreator,
};

export function repoCreatorFor(provider: GitProviderId): RepoCreator | null {
  return CREATORS[provider] ?? null;
}
