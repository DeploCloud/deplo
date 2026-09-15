import { parsePushEvent } from "../../deploy/git-webhook";

import {
  assertFullName,
  call,
  fetchRaw,
  json,
  PER_PAGE,
  REPO_PAGES,
} from "./api-client";
import { sameSecret } from "./signature";
import type { GitCredential, GitProviderApi, RepoSummary } from "./types";

const glProject = (fullName: string) =>
  `/api/v4/projects/${encodeURIComponent(assertFullName(fullName))}`;

const glAuth = (c: GitCredential) => ({ "PRIVATE-TOKEN": c.token });

function lastCommitMessage(
  commits: { message?: string }[] | undefined,
): string {
  const last = commits?.[commits.length - 1];
  return (last?.message ?? "").split("\n")[0]?.trim() ?? "";
}

export const gitlab: GitProviderApi = {
  async whoami(c) {
    const me = await json<{ username: string; avatar_url?: string }>(
      c,
      "/api/v4/user",
      { auth: glAuth(c) },
    );
    const self = await json<{
      expires_at?: string | null;
      scopes?: string[];
    }>(c, "/api/v4/personal_access_tokens/self", { auth: glAuth(c) }).catch(
      () => null,
    );
    return {
      login: me.username,
      avatarUrl: me.avatar_url ?? "",
      expiresAt: self?.expires_at ? `${self.expires_at}T00:00:00.000Z` : null,
      scopes: self?.scopes ?? null,
    };
  },

  async listRepos(c) {
    const out: RepoSummary[] = [];
    for (let page = 1; page <= REPO_PAGES; page++) {
      const rows = await json<
        {
          path_with_namespace: string;
          name: string;
          visibility: string;
          default_branch: string | null;
          web_url: string;
          last_activity_at: string;
        }[]
      >(
        c,
        `/api/v4/projects?membership=true&simple=true&per_page=${PER_PAGE}&page=${page}&order_by=last_activity_at`,
        { auth: glAuth(c) },
      );
      for (const r of rows) {
        out.push({
          fullName: r.path_with_namespace,
          name: r.name,
          private: r.visibility !== "public",
          defaultBranch: r.default_branch ?? "main",
          url: r.web_url,
          updatedAt: r.last_activity_at,
        });
      }
      if (rows.length < PER_PAGE) break;
    }
    return out;
  },

  async listBranches(c, fullName) {
    const rows = await json<{ name: string }[]>(
      c,
      `${glProject(fullName)}/repository/branches?per_page=100`,
      { auth: glAuth(c) },
    );
    return rows.map((b) => b.name);
  },

  async listWebhooks(c, fullName) {
    const rows = await json<{ id: number; url: string }[]>(
      c,
      `${glProject(fullName)}/hooks?per_page=100`,
      { auth: glAuth(c) },
    );
    return rows.map((h) => ({ id: String(h.id), url: h.url }));
  },

  async createWebhook(c, fullName, hookUrl, secret) {
    await call(c, `${glProject(fullName)}/hooks`, {
      auth: glAuth(c),
      method: "POST",
      body: JSON.stringify({
        url: hookUrl,
        token: secret,
        push_events: true,
        tag_push_events: true,
        enable_ssl_verification: true,
      }),
    });
  },

  async deleteWebhook(c, fullName, id) {
    await call(c, `${glProject(fullName)}/hooks/${encodeURIComponent(id)}`, {
      auth: glAuth(c),
      method: "DELETE",
    });
  },

  async listTree(c, fullName, ref) {
    const rows = await json<{ path: string; type: string }[]>(
      c,
      `${glProject(fullName)}/repository/tree?recursive=true&per_page=100&ref=${encodeURIComponent(ref)}`,
      { auth: glAuth(c) },
    );
    return rows.filter((e) => e.type === "blob").map((e) => e.path);
  },

  async readFileBytes(c, fullName, ref, path) {
    return fetchRaw(
      c,
      `${glProject(fullName)}/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(ref)}`,
      glAuth(c),
    );
  },

  verify(secret, headers) {
    const token = headers.get("x-gitlab-token") ?? "";
    return sameSecret(token, secret) ? "ok" : "bad";
  },

  parsePush(headers, payload) {
    const event = headers.get("x-gitlab-event") ?? "";
    if (event !== "Push Hook" && event !== "Tag Push Hook") return [];
    const p = payload as {
      ref?: string;
      after?: string;
      commits?: {
        message?: string;
        added?: string[];
        modified?: string[];
        removed?: string[];
      }[];
      project?: { path_with_namespace?: string };
      user_username?: string;
      user_name?: string;
    };
    const repoFullName = p.project?.path_with_namespace ?? "";
    if (!repoFullName || !p.ref) return [];
    const deleted = /^0+$/.test(p.after ?? "");
    return [
      {
        event: parsePushEvent({ ref: p.ref, deleted, commits: p.commits }),
        repoFullName,
        commitMessage: lastCommitMessage(p.commits) || (deleted ? "" : "Push"),
        author: p.user_username || p.user_name || "gitlab",
      },
    ];
  },
};
