import "server-only";

import type { SourceFile } from "../git/clone-archive";
import {
  batches,
  type CreatedRepo,
  type NewRepoSpec,
} from "../git/providers/create-repo";

// Only creation and a first commit: Deplo never deletes or rewrites a repository it did not just make.
const API = "https://api.github.com";
const UA = "Deplo";
const TIMEOUT_MS = 120_000;
const INLINE_MAX = 512 * 1024;

export class GithubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function gh<T>(
  token: string,
  path: string,
  init: { method: string; body?: unknown },
): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: init.method,
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": UA,
      Authorization: `Bearer ${token}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = await res
      .json()
      .then((j: { message?: string; errors?: { message?: string }[] }) =>
        [j.message, ...(j.errors ?? []).map((e) => e.message)]
          .filter(Boolean)
          .join(": "),
      )
      .catch(() => "");
    throw new GithubApiError(
      `GitHub refused (${res.status})${detail ? `: ${detail}` : ""}`,
      res.status,
    );
  }
  if (res.status === 204) return null as T;
  return (await res.json()) as T;
}

// Text goes inline in the tree request; anything that is not clean UTF-8 is uploaded as a blob first.
export function isInlineText(bytes: Buffer): boolean {
  if (bytes.length > INLINE_MAX || bytes.includes(0)) return false;
  return Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes);
}

export async function createGithubRepository(opts: {
  token: string;
  owner: string;
  personal: boolean;
  spec: NewRepoSpec;
}): Promise<{ id: number; fullName: string; url: string; branch: string }> {
  const repo = await gh<{
    id: number;
    full_name: string;
    html_url: string;
    default_branch?: string;
  }>(
    opts.token,
    opts.personal
      ? "/user/repos"
      : `/orgs/${encodeURIComponent(opts.owner)}/repos`,
    {
      method: "POST",
      body: {
        name: opts.spec.name,
        private: opts.spec.private,
        description: opts.spec.description.slice(0, 350),
        // The Git Data API refuses an empty repository; the placeholder commit is replaced below.
        auto_init: true,
      },
    },
  ).catch((e) => {
    if (e instanceof GithubApiError && e.status === 422)
      throw new Error(
        `${opts.owner} already has a repository called ${opts.spec.name}, or GitHub refused the name. Pick another name.`,
      );
    throw e;
  });
  return {
    id: repo.id,
    fullName: repo.full_name,
    url: repo.html_url,
    branch: repo.default_branch || "main",
  };
}

async function firstWrite<T>(run: () => Promise<T>): Promise<T> {
  // A repository GitHub has just created can answer 404/409 for a moment.
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (e) {
      const retry =
        e instanceof GithubApiError &&
        (e.status === 404 || e.status === 409) &&
        attempt < 4;
      if (!retry) throw e;
      await new Promise((r) => setTimeout(r, 750 * (attempt + 1)));
    }
  }
}

export async function pushGithubFiles(opts: {
  token: string;
  fullName: string;
  branch: string;
  message: string;
  files: SourceFile[];
}): Promise<CreatedRepo> {
  const { token, fullName } = opts;
  let tree: string | undefined;
  for (const batch of batches(opts.files)) {
    const entries: {
      path: string;
      mode: string;
      type: "blob";
      content?: string;
      sha?: string;
    }[] = [];
    for (const f of batch) {
      const mode = f.executable ? "100755" : "100644";
      if (isInlineText(f.bytes)) {
        entries.push({
          path: f.path,
          mode,
          type: "blob",
          content: f.bytes.toString("utf8"),
        });
        continue;
      }
      const blob = await firstWrite(() =>
        gh<{ sha: string }>(token, `/repos/${fullName}/git/blobs`, {
          method: "POST",
          body: { content: f.bytes.toString("base64"), encoding: "base64" },
        }),
      );
      entries.push({ path: f.path, mode, type: "blob", sha: blob.sha });
    }
    const base: string | undefined = tree;
    const made: { sha: string } = await firstWrite(() =>
      gh<{ sha: string }>(token, `/repos/${fullName}/git/trees`, {
        method: "POST",
        body: { tree: entries, ...(base ? { base_tree: base } : {}) },
      }),
    );
    tree = made.sha;
  }
  const commit = await gh<{ sha: string }>(
    token,
    `/repos/${fullName}/git/commits`,
    { method: "POST", body: { message: opts.message, tree, parents: [] } },
  );
  await gh(token, `/repos/${fullName}/git/refs/heads/${opts.branch}`, {
    method: "PATCH",
    body: { sha: commit.sha, force: true },
  });
  return {
    fullName,
    url: `https://github.com/${fullName}`,
    branch: opts.branch,
  };
}

// A repository made with a person's token joins an installation limited to chosen repositories only when asked.
export async function addRepoToInstallation(
  userToken: string,
  installationId: number,
  repositoryId: number,
): Promise<void> {
  await gh(
    userToken,
    `/user/installations/${installationId}/repositories/${repositoryId}`,
    { method: "PUT" },
  ).catch(() => {});
}
