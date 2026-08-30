// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { createHmac, timingSafeEqual } from "node:crypto";

import { parsePushEvent, type GitPushEvent } from "../deploy/git-webhook";
import type { GitProviderId } from "../types";

/**
 * Every git host that is NOT GitHub, behind one adapter. Three near-identical
 * clients would be three places to fix the same bug, so they share this shape and
 * differ only in their URLs and their JSON.
 */

/** A connection's credentials, with the token already decrypted by the caller. */
export interface GitCredential {
  provider: GitProviderId;
  /** Origin with no trailing slash, e.g. https://gitlab.com. */
  baseUrl: string;
  username: string;
  token: string;
}

/** One repository, in the shape the repo picker already renders for GitHub. */
export interface RepoSummary {
  fullName: string;
  name: string;
  private: boolean;
  defaultBranch: string;
  url: string;
  updatedAt: string;
}

/** Who a token belongs to, proven by calling the provider. */
export interface GitAccount {
  login: string;
  avatarUrl: string;
  /** ISO expiry when the provider reports one (GitLab does, Gitea does not). */
  expiresAt: string | null;
}

/** A registered webhook, reduced to what ensure/remove need. */
export interface WebhookRef {
  id: string;
  url: string;
}

/** One ref moved by a delivery, normalised across providers. */
export interface ParsedPush {
  event: GitPushEvent;
  repoFullName: string;
  commitMessage: string;
  author: string;
}

/**
 * The outcome of checking a delivery's authenticity. - `ok` the signature (or
 * shared token) matched - `bad` a signature was present and did NOT match: drop
 * it, 401 - `unsigned` the provider sent nothing to verify.
 */
export type VerifyResult = "ok" | "bad" | "unsigned";

/** The REST half of a provider. Null on `git`, which has no API at all. */
export interface GitProviderApi {
  whoami(c: GitCredential): Promise<GitAccount>;
  listRepos(c: GitCredential): Promise<RepoSummary[]>;
  listBranches(c: GitCredential, fullName: string): Promise<string[]>;
  listWebhooks(c: GitCredential, fullName: string): Promise<WebhookRef[]>;
  createWebhook(
    c: GitCredential,
    fullName: string,
    url: string,
    secret: string,
  ): Promise<void>;
  deleteWebhook(c: GitCredential, fullName: string, id: string): Promise<void>;
  /** Repo-root-relative POSIX paths of every file at `ref`. For framework
   *  detection, so a truncated list is fine - markers live near the root. */
  listTree(c: GitCredential, fullName: string, ref: string): Promise<string[]>;
  /** Raw bytes of one file, or null when absent/too large/unreadable. */
  readFileBytes(
    c: GitCredential,
    fullName: string,
    ref: string,
    path: string,
  ): Promise<Buffer | null>;
  verify(secret: string, headers: Headers, rawBody: string): VerifyResult;
  /** Every ref the delivery moved. Empty when it is not a push at all. */
  parsePush(headers: Headers, payload: unknown): ParsedPush[];
}

export interface GitProviderAdapter {
  /** The name the world already uses for this host. */
  label: string;
  /** Prefilled in the connect dialog; null when the host is always self-hosted. */
  defaultBaseUrl: string | null;
  /**
   * A fixed API origin, when the provider does not serve its API from the same
   * host it serves repositories from (Bitbucket: api.bitbucket.org). Absent for
   * the self-hostable ones, where the API lives on the connection's own baseUrl.
   */
  apiBaseUrl?: string;
  /** Basic-auth username for the clone URL. Empty ⇒ the user must supply theirs. */
  defaultUsername: string;
  /** The page that mints a token: absolute, or a path relative to baseUrl. */
  tokenHelpPath: string;
  /** The exact scopes to tick there, as one short line of UI copy. */
  tokenScopes: string;
  api: GitProviderApi | null;
}

const UA = "deplo";
const MAX_FILE_BYTES = 1_000_000;
/** Repository listing depth. 500 repos is far past what a picker with a search
 *  box is useful for, and every page is a round trip the user waits on. */
const PER_PAGE = 100;
const REPO_PAGES = 5;

/** Join the provider's API origin and an absolute path, without a double slash. */
function url(c: GitCredential, path: string): string {
  const origin = PROVIDERS[c.provider]?.apiBaseUrl ?? c.baseUrl;
  return `${origin.replace(/\/+$/, "")}${path}`;
}

/** The page where this connection's token is minted, ready to link to. */
export function tokenHelpUrl(provider: GitProviderId, baseUrl: string): string {
  const { tokenHelpPath } = providerFor(provider);
  if (!tokenHelpPath) return "";
  if (/^https?:\/\//.test(tokenHelpPath)) return tokenHelpPath;
  return `${baseUrl.replace(/\/+$/, "")}${tokenHelpPath}`;
}

/** owner/name, the only repo identifier any of these APIs is given. */
const FULL_NAME_RE = /^[\w.~-]+(?:\/[\w.~-]+)+$/;

function assertFullName(fullName: string): string {
  if (!FULL_NAME_RE.test(fullName)) throw new Error("Invalid repository");
  return fullName;
}

/**
 * How long any single provider request may take.
 */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * A fetch that gives up rather than hanging on an unreachable host, and that
 * NEVER follows a redirect.
 *
 * The base URL is checked for SSRF once, when the connection is saved
 * (`assertSafeOutboundUrl` in lib/data/git-connections.ts). A 302 is the way out
 * of that check: the host passes as a public address and then answers every
 * subsequent call with `Location: http://169.254.169.254/…`, which this module
 * would dial and, worse than the usual blind case, hand back in `call`'s error
 * message. `redirect: "manual"` closes it in one line, and is what
 * `lib/outbound-url.ts` documents every dialer as doing (the notification
 * channels already did).
 *
 * ponytail: a redirect is refused, not re-validated. Every provider API here
 * answers 200 directly; if a host is ever found that legitimately redirects
 * (a raw-file CDN hop), follow it manually and put each `Location` through the
 * outbound guard rather than turning this back on.
 */
function timedFetch(target: string, init: RequestInit): Promise<Response> {
  return fetch(target, {
    ...init,
    redirect: "manual",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

/**
 * One request against a provider, with its auth header and a readable failure.
 */
async function call(
  c: GitCredential,
  path: string,
  init: RequestInit & { auth: Record<string, string> },
): Promise<Response> {
  const { auth, ...rest } = init;
  const res = await timedFetch(url(c, path), {
    ...rest,
    headers: {
      Accept: "application/json",
      "User-Agent": UA,
      ...auth,
      ...(rest.body ? { "Content-Type": "application/json" } : {}),
      ...(rest.headers as Record<string, string> | undefined),
    },
  });
  // A redirect is refused rather than followed (see timedFetch), and the everyday
  // cause is not an attack: an `http://` address in front of a proxy that sends
  // everything to https.
  if (res.status >= 300 && res.status < 400) {
    const to = res.headers.get("location") ?? "";
    throw new Error(
      `${PROVIDERS[c.provider].label} answered with a redirect (${res.status})` +
        (to ? ` to ${to.slice(0, 200)}` : "") +
        ". Deplo does not follow redirects here. Point this connection at the address that answers directly.",
    );
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300).trim();
    throw new Error(
      `${PROVIDERS[c.provider].label} request failed (${res.status})` +
        (detail ? `: ${detail}` : ""),
    );
  }
  return res;
}

async function json<T>(
  c: GitCredential,
  path: string,
  init: RequestInit & { auth: Record<string, string> },
): Promise<T> {
  return (await call(c, path, init)).json() as Promise<T>;
}

/* ------------------------------------------------------------------ */
/* Signature verification                                              */
/* ------------------------------------------------------------------ */

/**
 * Constant-time compare of two same-purpose strings. An EMPTY expectation never
 * matches, whatever arrives. GitHub's own route already refuses on `!secret`; this
 * is the same refusal, for the providers that share this helper.
 */
function sameSecret(a: string, b: string): boolean {
  if (!a || !b) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  // timingSafeEqual throws on a length mismatch, so the length is checked first
  // and leaks only the length - which a caller controls anyway.
  return x.length === y.length && timingSafeEqual(x, y);
}

function hmacHex(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

/* ------------------------------------------------------------------ */
/* GitLab                                                              */
/* ------------------------------------------------------------------ */

/** GitLab addresses a project by its URL-encoded full path, so no id lookup. */
const glProject = (fullName: string) =>
  `/api/v4/projects/${encodeURIComponent(assertFullName(fullName))}`;

const glAuth = (c: GitCredential) => ({ "PRIVATE-TOKEN": c.token });

const gitlab: GitProviderApi = {
  async whoami(c) {
    const me = await json<{ username: string; avatar_url?: string }>(
      c,
      "/api/v4/user",
      { auth: glAuth(c) },
    );
    // Best-effort: only a personal access token can read its own metadata, and a
    // project/group access token 404s here. A missing expiry is not an error.
    const self = await json<{ expires_at?: string | null }>(
      c,
      "/api/v4/personal_access_tokens/self",
      { auth: glAuth(c) },
    ).catch(() => null);
    return {
      login: me.username,
      avatarUrl: me.avatar_url ?? "",
      expiresAt: self?.expires_at ? `${self.expires_at}T00:00:00.000Z` : null,
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
    const res = await timedFetch(
      url(
        c,
        `${glProject(fullName)}/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(ref)}`,
      ),
      { headers: { "User-Agent": UA, ...glAuth(c) } },
    );
    return readCapped(res);
  },

  verify(secret, headers) {
    const token = headers.get("x-gitlab-token") ?? "";
    // GitLab always sends the token it was configured with, so an absent header
    // is a forged (or misconfigured) delivery rather than an unsigned one.
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
    // GitLab has no `deleted` flag: an all-zero `after` sha is the deletion.
    const deleted = /^0+$/.test(p.after ?? "");
    // The commit objects carry the same added/modified/removed field names as
    // GitHub's, so the shared parser handles the ref + file-list normalisation.
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

/** GitLab puts each commit's message on the commit object; take the newest. */
function lastCommitMessage(
  commits: { message?: string }[] | undefined,
): string {
  const last = commits?.[commits.length - 1];
  return (last?.message ?? "").split("\n")[0]?.trim() ?? "";
}

/* ------------------------------------------------------------------ */
/* Gitea / Forgejo                                                     */
/* ------------------------------------------------------------------ */

const giAuth = (c: GitCredential) => ({ Authorization: `token ${c.token}` });
const giRepo = (fullName: string) =>
  `/api/v1/repos/${assertFullName(fullName)}`;

const gitea: GitProviderApi = {
  async whoami(c) {
    const me = await json<{ login: string; avatar_url?: string }>(
      c,
      "/api/v1/user",
      { auth: giAuth(c) },
    );
    return {
      login: me.login,
      avatarUrl: me.avatar_url ?? "",
      expiresAt: null, // Gitea tokens do not expire.
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
    const res = await timedFetch(
      url(
        c,
        `${giRepo(fullName)}/raw/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`,
      ),
      { headers: { "User-Agent": UA, ...giAuth(c) } },
    );
    return readCapped(res);
  },

  verify(secret, headers, rawBody) {
    // Gitea signs with its own header; newer versions also send GitHub's. Either
    // is accepted so the same connection keeps working across an upgrade.
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
    // Gitea's push payload is GitHub-shaped down to the field names, so the
    // GitHub parser is the parser.
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

/* ------------------------------------------------------------------ */
/* Bitbucket Cloud                                                     */
/* ------------------------------------------------------------------ */

const bbAuth = (c: GitCredential) => ({
  Authorization: `Basic ${Buffer.from(`${c.username}:${c.token}`).toString("base64")}`,
});
const bbRepo = (fullName: string) =>
  `/2.0/repositories/${assertFullName(fullName)}`;

const bitbucket: GitProviderApi = {
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
      };
    }
    // A token scoped to repositories only cannot read /2.0/user. Prove it works
    // by listing a single repository instead of rejecting a perfectly good token.
    await call(c, "/2.0/repositories?role=member&pagelen=1", {
      auth: bbAuth(c),
    });
    return { login: c.username, avatarUrl: "", expiresAt: null };
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
    // Only the root listing: Bitbucket has no cheap recursive tree, and the root
    // markers are all framework/favicon detection reads.
    return (res.values ?? [])
      .filter((e) => e.type === "commit_file")
      .map((e) => e.path);
  },

  async readFileBytes(c, fullName, ref, path) {
    const res = await timedFetch(
      url(
        c,
        `${bbRepo(fullName)}/src/${encodeURIComponent(ref)}/${path.split("/").map(encodeURIComponent).join("/")}`,
      ),
      { headers: { "User-Agent": UA, ...bbAuth(c) } },
    );
    return readCapped(res);
  },

  verify(secret, headers, rawBody) {
    const sig = headers.get("x-hub-signature");
    // Bitbucket signs only when a secret is set on its side. Without one there is
    // nothing to check here, and the unguessable token in the delivery URL is the
    // shared secret - the caller decides whether that is enough.
    if (!sig) return "unsigned";
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
    // One delivery can move several refs (pushing two branches at once), so every
    // change is its own event rather than only the first.
    return (p.push?.changes ?? []).map((ch) => ({
      event: {
        isTag: ch.new?.type === "tag",
        refName: ch.new?.name ?? ch.old?.name ?? "",
        deleted: !ch.new,
        // Bitbucket does not send a file list. An empty one makes the watch-path
        // and skip-unchanged filters fail open, which is the documented contract
        // for a delivery that carries no paths.
        changedPaths: [],
      },
      repoFullName,
      commitMessage:
        (ch.new?.target?.message ?? "").split("\n")[0]?.trim() || "Push",
      author,
    }));
  },
};

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

/** Body of a raw-file response, refusing anything oversized or missing. Bytes
 *  rather than text: the same reader feeds favicon detection, and decoding a
 *  .ico as UTF-8 would corrupt it. */
async function readCapped(res: Response): Promise<Buffer | null> {
  if (!res.ok) return null;
  const len = Number(res.headers.get("content-length") ?? "0");
  if (len > MAX_FILE_BYTES) return null;
  const buf = await res
    .arrayBuffer()
    .then((b) => Buffer.from(b))
    .catch(() => null);
  if (buf == null || buf.byteLength > MAX_FILE_BYTES) return null;
  return buf;
}

/** UTF-8 contents of one file, or null when it cannot be read. */
export async function readProviderText(
  api: GitProviderApi,
  c: GitCredential,
  fullName: string,
  ref: string,
  path: string,
): Promise<string | null> {
  const bytes = await api.readFileBytes(c, fullName, ref, path);
  return bytes ? bytes.toString("utf8") : null;
}

/* ------------------------------------------------------------------ */
/* The catalogue                                                       */
/* ------------------------------------------------------------------ */

export const PROVIDERS: Record<GitProviderId, GitProviderAdapter> = {
  gitlab: {
    label: "GitLab",
    defaultBaseUrl: "https://gitlab.com",
    // Any username works with a GitLab token; "oauth2" is the documented one.
    defaultUsername: "oauth2",
    tokenHelpPath: "/-/user_settings/personal_access_tokens",
    tokenScopes: "api, read_repository",
    api: gitlab,
  },
  bitbucket: {
    label: "Bitbucket",
    defaultBaseUrl: "https://bitbucket.org",
    // Bitbucket Cloud serves its API from a different host than its repositories,
    // and cannot be self-hosted, so the API origin is fixed rather than derived.
    apiBaseUrl: "https://api.bitbucket.org",
    // Right for an API token. With an app password it is your own username, which
    // is why the field stays editable.
    defaultUsername: "x-token-auth",
    tokenHelpPath: "/account/settings/app-passwords/",
    tokenScopes: "Repositories: Read, Webhooks: Read and write",
    api: bitbucket,
  },
  gitea: {
    label: "Gitea / Forgejo",
    defaultBaseUrl: null,
    // Gitea wants the real account name alongside the token.
    defaultUsername: "",
    tokenHelpPath: "/user/settings/applications",
    tokenScopes: "read:repository, write:repository",
    api: gitea,
  },
  git: {
    label: "Git",
    defaultBaseUrl: null,
    defaultUsername: "",
    tokenHelpPath: "",
    tokenScopes: "",
    // No API: a plain git server offers nothing to list, browse or register a
    // webhook on. The connection carries credentials and nothing else.
    api: null,
  },
};

/** Every provider id Deplo recognises. Anything else is a plain git remote. */
export const KNOWN_PROVIDERS = new Set<GitProviderId>(
  Object.keys(PROVIDERS) as GitProviderId[],
);

/** The adapter for a provider id, or the plain-git one for anything unknown. */
export function providerFor(id: string): GitProviderAdapter {
  return PROVIDERS[id as GitProviderId] ?? PROVIDERS.git;
}

/* ------------------------------------------------------------------ */
/* Webhook lifecycle (written once, on top of list/create/delete)      */
/* ------------------------------------------------------------------ */

/** Whether our hook URL is already registered on the repository. */
export async function hasWebhook(
  c: GitCredential,
  fullName: string,
  hookUrl: string,
): Promise<boolean> {
  const api = providerFor(c.provider).api;
  if (!api) return false;
  return (await api.listWebhooks(c, fullName)).some((h) => h.url === hookUrl);
}

/**
 * Register our push webhook if it is not there yet. Idempotent and keyed on the
 * URL, so two Apps deploying from the same repository share one hook instead of
 * accumulating duplicates.
 */
export async function ensureWebhook(
  c: GitCredential,
  fullName: string,
  hookUrl: string,
  secret: string,
): Promise<void> {
  const api = providerFor(c.provider).api;
  if (!api) return;
  const existing = await api.listWebhooks(c, fullName);
  if (existing.some((h) => h.url === hookUrl)) return;
  await api.createWebhook(c, fullName, hookUrl, secret);
}

/** Remove our hook from a repository (no-op when it was never registered). */
export async function removeWebhook(
  c: GitCredential,
  fullName: string,
  hookUrl: string,
): Promise<void> {
  const api = providerFor(c.provider).api;
  if (!api) return;
  for (const h of await api.listWebhooks(c, fullName)) {
    if (h.url === hookUrl) await api.deleteWebhook(c, fullName, h.id);
  }
}
