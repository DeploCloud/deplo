import { parsePushEvent } from "../../deploy/git-webhook";

import {
  assertFullName,
  call,
  fetchRaw,
  json,
  PER_PAGE,
  REPO_PAGES,
} from "./api-client";
import { hmacHex, sameSecret } from "./signature";
import type { GitCredential, GitProviderApi, RepoSummary } from "./types";

const giAuth = (c: GitCredential) => ({ Authorization: `token ${c.token}` });
const giRepo = (fullName: string) =>
  `/api/v1/repos/${assertFullName(fullName)}`;

export const gitea: GitProviderApi = {
  async whoami(c) {
    const me = await json<{ login: string; avatar_url?: string }>(
      c,
      "/api/v1/user",
      { auth: giAuth(c) },
    );
    return {
      login: me.login,
      avatarUrl: me.avatar_url ?? "",
      expiresAt: null,
      scopes: null,
    };
  },

  async listRepos(c) {
    const out: RepoSummary[] = [];
    for (let page = 1; page <= REPO_PAGES; page++) {
      const rows = await json<
        {
          full_name: string;
          name: string;
          private: boolean;
          default_branch: string;
          html_url: string;
          updated_at: string;
        }[]
      >(c, `/api/v1/user/repos?limit=${PER_PAGE}&page=${page}`, {
        auth: giAuth(c),
      });
      for (const r of rows) {
        out.push({
          fullName: r.full_name,
          name: r.name,
          private: r.private,
          defaultBranch: r.default_branch || "main",
          url: r.html_url,
          updatedAt: r.updated_at,
        });
      }
      if (rows.length < PER_PAGE) break;
    }
    return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  },

  async listBranches(c, fullName) {
    const rows = await json<{ name: string }[]>(
      c,
      `${giRepo(fullName)}/branches?limit=100`,
      { auth: giAuth(c) },
    );
    return rows.map((b) => b.name);
  },

  async listWebhooks(c, fullName) {
    const rows = await json<{ id: number; config?: { url?: string } }[]>(
      c,
      `${giRepo(fullName)}/hooks?limit=100`,
      { auth: giAuth(c) },
    );
    return rows.map((h) => ({ id: String(h.id), url: h.config?.url ?? "" }));
  },

  async createWebhook(c, fullName, hookUrl, secret) {
    await call(c, `${giRepo(fullName)}/hooks`, {
      auth: giAuth(c),
      method: "POST",
      body: JSON.stringify({
        type: "gitea",
        active: true,
        events: ["push"],
        config: { url: hookUrl, content_type: "json", secret },
      }),
    });
  },

  async deleteWebhook(c, fullName, id) {
    await call(c, `${giRepo(fullName)}/hooks/${encodeURIComponent(id)}`, {
      auth: giAuth(c),
      method: "DELETE",
    });
  },

  async listTree(c, fullName, ref) {
    const res = await json<{ tree?: { path: string; type: string }[] }>(
      c,
      `${giRepo(fullName)}/git/trees/${encodeURIComponent(ref)}?recursive=true&per_page=1000`,
      { auth: giAuth(c) },
    );
    return (res.tree ?? []).filter((e) => e.type === "blob").map((e) => e.path);
  },

  async readFileBytes(c, fullName, ref, path) {
    return fetchRaw(
      c,
      `${giRepo(fullName)}/raw/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`,
      giAuth(c),
    );
  },

  verify(secret, headers, rawBody) {
    const own = headers.get("x-gitea-signature");
    if (own) return sameSecret(own, hmacHex(secret, rawBody)) ? "ok" : "bad";
    const gh = headers.get("x-hub-signature-256");
    if (gh) {
      return sameSecret(gh, `sha256=${hmacHex(secret, rawBody)}`)
        ? "ok"
        : "bad";
    }
    return "bad";
  },

  parsePush(headers, payload) {
    const event = headers.get("x-gitea-event") ?? headers.get("x-github-event");
    if (event !== "push") return [];
    const p = payload as {
      ref?: string;
      deleted?: boolean;
      commits?: { added?: string[]; modified?: string[]; removed?: string[] }[];
      repository?: { full_name?: string };
      head_commit?: { message?: string } | null;
      pusher?: { username?: string; login?: string };
    };
    const repoFullName = p.repository?.full_name ?? "";
    if (!repoFullName || !p.ref) return [];
    return [
      {
        event: parsePushEvent(p),
        repoFullName,
        commitMessage:
          (p.head_commit?.message ?? "").split("\n")[0]?.trim() || "Push",
        author: p.pusher?.username || p.pusher?.login || "gitea",
      },
    ];
  },
};
