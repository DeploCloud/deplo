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

const bbAuth = (c: GitCredential) => ({
  Authorization: `Basic ${Buffer.from(`${c.username}:${c.token}`).toString("base64")}`,
});
const bbRepo = (fullName: string) =>
  `/2.0/repositories/${assertFullName(fullName)}`;

export const bitbucket: GitProviderApi = {
  async whoami(c) {
    const me = await json<{
      username?: string;
      nickname?: string;
      links?: { avatar?: { href?: string } };
    }>(c, "/2.0/user", { auth: bbAuth(c) }).catch(() => null);
    if (me) {
      return {
        login: me.username || me.nickname || "",
        avatarUrl: me.links?.avatar?.href ?? "",
        expiresAt: null,
        scopes: null,
      };
    }
    await call(c, "/2.0/repositories?role=member&pagelen=1", {
      auth: bbAuth(c),
    });
    return { login: c.username, avatarUrl: "", expiresAt: null, scopes: null };
  },

  async listRepos(c) {
    const out: RepoSummary[] = [];
    for (let page = 1; page <= REPO_PAGES; page++) {
      const res = await json<{
        values?: {
          full_name: string;
          name: string;
          is_private: boolean;
          mainbranch?: { name?: string } | null;
          links?: { html?: { href?: string } };
          updated_on: string;
        }[];
        next?: string;
      }>(
        c,
        `/2.0/repositories?role=member&sort=-updated_on&pagelen=${PER_PAGE}&page=${page}`,
        { auth: bbAuth(c) },
      );
      for (const r of res.values ?? []) {
        out.push({
          fullName: r.full_name,
          name: r.name,
          private: r.is_private,
          defaultBranch: r.mainbranch?.name || "main",
          url: r.links?.html?.href ?? "",
          updatedAt: r.updated_on,
        });
      }
      if (!res.next) break;
    }
    return out;
  },

  async listBranches(c, fullName) {
    const res = await json<{ values?: { name: string }[] }>(
      c,
      `${bbRepo(fullName)}/refs/branches?pagelen=100`,
      { auth: bbAuth(c) },
    );
    return (res.values ?? []).map((b) => b.name);
  },

  async listWebhooks(c, fullName) {
    const res = await json<{ values?: { uuid: string; url: string }[] }>(
      c,
      `${bbRepo(fullName)}/hooks?pagelen=100`,
      { auth: bbAuth(c) },
    );
    return (res.values ?? []).map((h) => ({ id: h.uuid, url: h.url }));
  },

  async createWebhook(c, fullName, hookUrl, secret) {
    await call(c, `${bbRepo(fullName)}/hooks`, {
      auth: bbAuth(c),
      method: "POST",
      body: JSON.stringify({
        description: "Deplo",
        url: hookUrl,
        active: true,
        events: ["repo:push"],
        secret,
      }),
    });
  },

  async deleteWebhook(c, fullName, id) {
    await call(c, `${bbRepo(fullName)}/hooks/${encodeURIComponent(id)}`, {
      auth: bbAuth(c),
      method: "DELETE",
    });
  },

  async listTree(c, fullName, ref) {
    const res = await json<{ values?: { path: string; type: string }[] }>(
      c,
      `${bbRepo(fullName)}/src/${encodeURIComponent(ref)}/?pagelen=100`,
      { auth: bbAuth(c) },
    );
    return (res.values ?? [])
      .filter((e) => e.type === "commit_file")
      .map((e) => e.path);
  },

  async readFileBytes(c, fullName, ref, path) {
    return fetchRaw(
      c,
      `${bbRepo(fullName)}/src/${encodeURIComponent(ref)}/${path.split("/").map(encodeURIComponent).join("/")}`,
      bbAuth(c),
    );
  },

  verify(secret, headers, rawBody) {
    const sig = headers.get("x-hub-signature");
    if (!sig) return "bad";
    return sameSecret(sig, `sha256=${hmacHex(secret, rawBody)}`) ? "ok" : "bad";
  },

  parsePush(headers, payload) {
    if ((headers.get("x-event-key") ?? "") !== "repo:push") return [];
    const p = payload as {
      repository?: { full_name?: string };
      actor?: { nickname?: string; display_name?: string };
      push?: {
        changes?: {
          new?: {
            type?: string;
            name?: string;
            target?: { message?: string };
          } | null;
          old?: { name?: string } | null;
        }[];
      };
    };
    const repoFullName = p.repository?.full_name ?? "";
    if (!repoFullName) return [];
    const author = p.actor?.nickname || p.actor?.display_name || "bitbucket";
    return (p.push?.changes ?? []).map((ch) => ({
      event: {
        isTag: ch.new?.type === "tag",
        refName: ch.new?.name ?? ch.old?.name ?? "",
        deleted: !ch.new,
        changedPaths: [],
      },
      repoFullName,
      commitMessage:
        (ch.new?.target?.message ?? "").split("\n")[0]?.trim() || "Push",
      author,
    }));
  },
};
